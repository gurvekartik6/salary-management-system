import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileTypeFromFile } from 'file-type';

import {
  Upload,
  ExtractedRecord,
  Campaign,
  SystemSetting,
} from '../models/index.js';

import { requireRole } from '../middleware/auth.js';
import { getProcessingQueue } from '../services/queue.js';
import { createCampaignFromUpload } from '../services/campaigns.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(requireRole('admin'));

router.param('id', (req, res, next, value) =>
  mongoose.Types.ObjectId.isValid(value)
    ? next()
    : res.status(404).json({ error: 'Resource not found' }),
);

router.param('recordId', (req, res, next, value) =>
  mongoose.Types.ObjectId.isValid(value)
    ? next()
    : res.status(404).json({ error: 'Resource not found' }),
);

const privateDir = path.resolve(
  process.env.PRIVATE_UPLOAD_DIR || './server/private-uploads',
);

await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });

const storage = multer.diskStorage({
  destination: privateDir,
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
});

const maxBytes =
  Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024;

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again later.' },
});

const allowedExtensions = new Set(['.csv', '.xlsx', '.xls', '.pdf']);

const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: maxBytes,
    files: 1,
    fields: 10,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(ext)) {
      return cb(
        Object.assign(
          new Error('Only CSV, XLSX, XLS and PDF files are accepted'),
          { status: 400 },
        ),
      );
    }

    cb(null, true);
  },
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ref() {
  return `SGGS-UP-${new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function cleanString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeLanguage(value, fallback = 'en') {
  const language = cleanString(value || fallback).toLowerCase();

  if (['mr', 'marathi'].includes(language)) return 'mr';
  if (['hi', 'hindi'].includes(language)) return 'hi';
  if (['en', 'english'].includes(language)) return 'en';

  return null;
}

function normalizeSalary(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const cleaned = String(value)
    .replace(/[₹,\s]/g, '')
    .replace(/^(INR|Rs\.?)/i, '');

  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }

  const amount = Number(cleaned);

  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) {
    return null;
  }

  return cleaned;
}

async function validateFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const head = await fs
    .readFile(file.path)
    .then((buffer) => buffer.subarray(0, 4096));

  if (ext === '.csv') {
    if (head.includes(0)) {
      throw new Error('CSV file appears to contain binary data');
    }

    return 'text/csv';
  }

  const type = await fileTypeFromFile(file.path);

  if (ext === '.pdf' && type?.mime !== 'application/pdf') {
    throw new Error('PDF signature does not match the file extension');
  }

  if (
    ext === '.xlsx' &&
    ![
      'application/zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ].includes(type?.mime)
  ) {
    throw new Error('XLSX file signature is invalid');
  }

  if (ext === '.xls' && type?.mime !== 'application/vnd.ms-excel') {
    throw new Error('XLS file signature is invalid');
  }

  return type?.mime || 'application/octet-stream';
}

router.post(
  '/',
  uploadLimiter,
  uploadMiddleware.single('file'),
  async (req, res, next) => {
    let file;
    let createdUpload;
    let queued = false;

    try {
      file = req.file;

      if (!file) {
        return res.status(400).json({ error: 'Choose a document to upload' });
      }

      const uploadPolicy =
        (await SystemSetting.findOne({ key: 'uploadPolicy' }).lean())
          ?.value || {};

      const configuredLimit =
        Number(uploadPolicy.maxUploadMB || process.env.MAX_UPLOAD_MB || 20) *
        1024 *
        1024;

      if (file.size > configuredLimit) {
        await fs.unlink(file.path).catch(() => {});

        return res.status(413).json({
          error: `File exceeds the configured ${Math.round(
            configuredLimit / 1024 / 1024,
          )} MB upload limit`,
        });
      }

      const mimeType = await validateFile(file);
      const bytes = await fs.readFile(file.path);

      const sha256 = crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex');

      const retentionPolicy =
        (await SystemSetting.findOne({ key: 'retentionPolicy' }).lean())
          ?.value || {};

      const retentionDays = Number(
        retentionPolicy.uploadRetentionDays ||
          process.env.UPLOAD_RETENTION_DAYS ||
          90,
      );

      const upload = await Upload.create({
        reference: ref(),
        originalName: path.basename(file.originalname).slice(0, 240),
        storagePath: file.path,
        sha256,
        mimeType,
        sizeBytes: file.size,
        uploadedBy: req.user.id,
        uploaderRole: req.user.role,
        status: 'uploaded',
        expiresAt: new Date(Date.now() + retentionDays * 86400000),
      });

      createdUpload = upload;

      await getProcessingQueue().add(
        'process-upload',
        { uploadId: String(upload._id) },
        {
          jobId: `upload-${upload._id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );

      queued = true;

      await audit(
        req,
        'upload.created',
        'upload',
        upload._id,
        'success',
        {
          reference: upload.reference,
          sizeBytes: upload.sizeBytes,
          mimeType,
        },
      );

      return res.status(202).json({
        upload: {
          id: upload._id,
          reference: upload.reference,
          originalName: upload.originalName,
          status: upload.status,
        },
        message: 'Document accepted for background processing.',
      });
    } catch (error) {
      if (file?.path && !queued) {
        await fs.unlink(file.path).catch(() => {});
      }

      if (createdUpload && !queued) {
        await Upload.deleteOne({ _id: createdUpload._id }).catch(() => {});
      }

      return next(error);
    }
  },
);

router.get('/', async (req, res) => {
  const items = await Upload.find({})
    .select('-storagePath')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return res.json({ items });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const upload = await Upload.findById(req.params.id).select('+storagePath');
  if (!upload) return res.status(404).json({ error: 'Upload not found' });
  const linkedCampaign = await Campaign.findOne({ upload: upload._id }).select('_id').lean();
  if (linkedCampaign) {
    return res.status(409).json({ error: 'This document is linked to a campaign and cannot be deleted' });
  }
  if (upload.storagePath) await fs.unlink(upload.storagePath).catch(() => {});
  await ExtractedRecord.deleteMany({ upload: upload._id });
  await Upload.deleteOne({ _id: upload._id });
  await audit(req, 'upload.deleted', 'upload', upload._id, 'success', { reference: upload.reference });
  return res.json({ ok: true });
});

router.get('/:id', async (req, res) => {
  const item = await Upload.findOne({
    _id: req.params.id
  }).select('-storagePath').lean();

  if (!item) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  return res.json({ upload: item });
});

router.get('/:id/preview', async (req, res) => {
  const upload = await Upload.findOne({
    _id: req.params.id
  }).select('-storagePath').lean();

  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  const records = await ExtractedRecord.find({ upload: upload._id })
    .select('-raw')
    .sort({ sourceRow: 1 })
    .limit(2000)
    .lean();

  return res.json({
    upload,
    records: records.map(record => ({
      ...record,
      salaryAmount:
        record.salaryAmount?.toString?.() ??
        record.salaryAmount ??
        '',
    })),
  });
});

router.patch('/:id/records/:recordId', async (req, res) => {
  const upload = await Upload.findOne({
    _id: req.params.id,
    status: 'review',
  });

  if (!upload) {
    return res.status(404).json({ error: 'Editable upload not found' });
  }

  const record = await ExtractedRecord.findOne({
    _id: req.params.recordId,
    upload: upload._id,
  });

  if (!record) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const body = req.body || {};

  const allowed = [
    'name',
    'email',
    'phone',
    'language',
    'salaryAmount',
    'salaryPeriod',
  ];

  if (Object.hasOwn(body, 'salaryAmount')) {
    const amount = normalizeSalary(body.salaryAmount);

    if (amount === null) {
      return res.status(400).json({
        error: 'Salary amount must be a valid non-negative number',
      });
    }

    record.salaryAmount = amount;
  }

  if (Object.hasOwn(body, 'email')) {
    const email = cleanString(body.email);

    if (email && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    record.email = email;
  }

  if (Object.hasOwn(body, 'phone')) {
    const phone = cleanString(body.phone);

    if (phone && phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    record.phone = phone;
  }

  if (Object.hasOwn(body, 'language')) {
    const language = normalizeLanguage(body.language);

    if (!language) {
      return res.status(400).json({
        error: 'Language must be English, Marathi or Hindi',
      });
    }

    record.language = language;
  }

  for (const key of allowed) {
    if (!Object.hasOwn(body, key)) continue;
    if (['salaryAmount', 'email', 'phone', 'language'].includes(key)) continue;

    record[key] = cleanString(body[key]);
  }

  const exceptionReason = cleanString(body.exceptionReason);
  const errors = [];

  if (!cleanString(record.name)) errors.push('Missing employee name');

  if (!cleanString(record.email)) {
    errors.push('Verified email is required');
  } else if (!EMAIL_REGEX.test(cleanString(record.email))) {
    errors.push('Invalid email format');
  }

  if (!cleanString(record.phone)) {
    errors.push('Verified mobile number is required');
  } else if (cleanString(record.phone).replace(/\D/g, '').length < 10) {
    errors.push('Invalid phone number');
  }

  const salary = normalizeSalary(
    record.salaryAmount?.toString?.() ?? record.salaryAmount,
  );

  if (salary === null) {
    errors.push('Valid salary amount is required');
  } else {
    record.salaryAmount = salary;
  }

  if (!['en', 'mr', 'hi'].includes(record.language)) {
    errors.push('Language must be English, Marathi or Hindi');
  }

  record.errors = errors;
  record.valid = errors.length === 0 && !record.excluded;
  record.reviewedBy = req.user.id;
  record.reviewedAt = new Date();
  if (exceptionReason.length >= 5) record.exceptionReason = exceptionReason;

  await record.save();

  const rowStats = await ExtractedRecord.find({ upload: upload._id })
    .select('valid excluded duplicate')
    .lean();

  upload.validCount = rowStats.filter(
    (row) => row.valid && !row.excluded,
  ).length;

  upload.invalidCount = rowStats.filter(
    (row) => !row.valid && !row.excluded,
  ).length;

  upload.duplicateCount = rowStats.filter(
    (row) => row.duplicate && !row.excluded,
  ).length;

  await upload.save();

  await audit(
    req,
    'upload.record.corrected',
    'extracted-record',
    record._id,
    'success',
    {
      uploadId: upload._id,
    },
  );

  return res.json({ record });
});

router.post('/:id/submit', requireRole('admin'), async (req, res) => {
  try {
    const campaign = await createCampaignFromUpload(
      req,
      req.params.id,
      req.body?.title,
      req.body?.channels,
    );

    return res.status(201).json({ campaign });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
});

router.post('/:id/reprocess', requireRole('admin'), async (req, res) => {
  const upload = await Upload.findById(req.params.id);

  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  const linkedCampaign = await Campaign.findOne({
    upload: upload._id
  }).select('reference status').lean();

  if (linkedCampaign) {
    return res.status(409).json({
      error: `This document is linked to campaign ${linkedCampaign.reference} and cannot be reprocessed`
    });
  }

  if (['processing', 'submitted'].includes(upload.status)) {
    return res.status(409).json({
      error: `This document cannot be reprocessed while it is ${upload.status}`
    });
  }

  upload.status = 'uploaded';
  await upload.save();

  await getProcessingQueue().add(
    'process-upload',
    { uploadId: String(upload._id) },
    { jobId: `upload-${upload._id}-retry-${Date.now()}` },
  );

  await audit(req, 'upload.reprocess.requested', 'upload', upload._id);

  return res.status(202).json({ ok: true });
});

export default router;