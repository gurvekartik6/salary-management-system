import { Router } from 'express';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  Employee,
  MiscellaneousContact,
  Sequence,
  Campaign,
  Upload,
  ExtractedRecord,
  Template,
  SiteContent,
  SystemSetting,
  AuditLog,
  DeliveryJob,
  UsageRecord,
  BackupRecord,
  Bill
} from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { getBackupQueue, getNotificationQueue } from '../services/queue.js';
import { getBackupDirectory, verifyEncryptedBackup } from '../services/backupService.js';
import {
  testEmailProvider,
  testSmsProvider,
  testWhatsAppProvider
} from '../services/notifications.js';
import { normalizePhone, isValidEmail } from '../utils/contacts.js';
import { recalculateCampaign } from '../workers/index.js';
import { invalidateSetting } from '../services/settings.js';

const router = Router();

router.param('id', (req, res, next, value) =>
  mongoose.Types.ObjectId.isValid(value)
    ? next()
    : res.status(404).json({ error: 'Resource not found' })
);

router.use(requireRole('admin'));

const assetDir = path.resolve(
  process.env.PUBLIC_ASSET_DIR || './server/public-assets'
);

await fs.mkdir(assetDir, { recursive: true, mode: 0o755 });

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  }
});

const assetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Image upload limit reached. Try again later.' }
});

const backupLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Backup creation limit reached for today.' }
});

// Dashboard and reports

router.get('/reports', async (_req, res) => {
  const { ReportJob } = await import('../models/index.js');

  const items = await ReportJob.find()
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  res.json({ items });
});

router.get('/dashboard', async (_req, res) => {
  const [
    uploads,
    campaigns,
    deliveries,
    failed,
    pending,
    costs
  ] = await Promise.all([
    Upload.countDocuments(),
    Campaign.countDocuments(),
    DeliveryJob.countDocuments(),
    DeliveryJob.countDocuments({ status: 'failed' }),
    Campaign.countDocuments({ status: 'awaiting_approval' }),
    UsageRecord.aggregate([
      {
        $group: {
          _id: null,
          estimated: { $sum: '$estimatedCost' },
          actual: { $sum: '$actualCost' }
        }
      }
    ])
  ]);

  const recent = await Campaign.find()
    .select('reference title status createdAt counters')
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();

  res.json({
    stats: {
      uploads,
      campaigns,
      deliveries,
      failed,
      pendingApproval: pending,
      estimatedCost: costs[0]?.estimated || 0,
      actualCost: costs[0]?.actual || 0
    },
    recent
  });
});

// Directory helpers

async function nextDirectoryId(key, prefix) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const seq = await Sequence.findOneAndUpdate(
      { key },
      { $inc: { value: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const candidate = `${prefix}-${String(seq.value).padStart(6, '0')}`;

    const exists = key === 'employee'
      ? await Employee.exists({ staffId: candidate })
      : await MiscellaneousContact.exists({ staffId: candidate });

    if (!exists) return candidate;
  }

  throw Object.assign(
    new Error('Could not allocate a unique directory ID. Contact the system administrator.'),
    { status: 503 }
  );
}

function directoryQuery(q) {
  const escaped = String(q || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!escaped) return {};

  const rx = new RegExp(escaped, 'i');

  return {
    $or: [
      { staffId: rx },
      { payrollId: rx },
      { name: rx },
      { email: rx },
      { organization: rx }
    ]
  };
}

// Employee directory

router.get('/employees', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const filter = directoryQuery(req.query.q);

  const [items, total] = await Promise.all([
    Employee.find(filter)
      .sort({ staffId: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter)
  ]);

  res.json({ items, page, limit, total });
});

router.post('/employees', async (req, res) => {
  const name = String(req.body?.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const payrollId = String(req.body?.payrollId || '').trim().toUpperCase();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const rawPhone = String(req.body?.phone || '').trim();
  const phone = normalizePhone(rawPhone);

  const language = ['en', 'mr', 'hi'].includes(req.body?.language)
    ? req.body.language
    : 'en';

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (rawPhone && !phone) {
    return res.status(400).json({
      error: 'Mobile number must be a valid international number or a 10-digit Indian mobile number'
    });
  }

  if (payrollId) {
    const existing = await Employee.findOne({
      $or: [{ payrollId }, { staffId: payrollId }]
    });

    if (existing) {
      existing.payrollId = payrollId;
      existing.name = name;
      existing.email = email;
      existing.phone = phone;
      existing.language = language;
      existing.active = req.body?.active !== false;
      existing.source = 'manual';
      existing.updatedBy = req.user.id;

      await existing.save();

      await audit(
        req,
        'employee.updated',
        'employee',
        existing._id,
        'success',
        { staffId: existing.staffId, payrollId }
      );

      return res.json({ employee: existing, created: false });
    }
  }

  const staffId = await nextDirectoryId('employee', 'EMP');

  const employee = await Employee.create({
    staffId,
    payrollId: payrollId || undefined,
    name,
    email,
    phone,
    language,
    active: req.body?.active !== false,
    source: 'manual',
    updatedBy: req.user.id
  });

  await audit(
    req,
    'employee.created',
    'employee',
    employee._id,
    'success',
    { staffId, payrollId }
  );

  res.status(201).json({ employee, created: true });
});

router.post('/employees/import-csv', async (req, res) => {
  const csv = String(req.body?.csv || '');

  if (!csv || csv.length > 5_000_000) {
    return res.status(400).json({
      error: 'CSV content is required and must be under 5 MB'
    });
  }

  let rows;

  try {
    rows = parseCsv(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
  } catch {
    return res.status(400).json({ error: 'Could not parse CSV' });
  }

  if (rows.length > 20000) {
    return res.status(400).json({
      error: 'Employee import is limited to 20,000 rows per batch'
    });
  }

  let upserted = 0;
  let rejected = 0;

  for (const row of rows) {
    const norm = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.toLowerCase().replace(/[_\s-]/g, ''),
        String(value || '').trim()
      ])
    );

    const payrollId = String(
      norm.payrollid ||
      norm.staffid ||
      norm.employeeid ||
      norm.empid ||
      norm.employeecode ||
      ''
    ).trim().toUpperCase();

    const name = norm.name || norm.employeename;

    if (!name) {
      rejected++;
      continue;
    }

    const email = String(
      norm.email || norm.emailaddress || ''
    ).trim().toLowerCase();

    const rawPhone = String(
      norm.phone || norm.mobile || norm.mobilenumber || ''
    ).trim();

    const phone = normalizePhone(rawPhone);

    const language = ['mr', 'marathi'].includes(
      (norm.language || '').toLowerCase()
    )
      ? 'mr'
      : ['hi', 'hindi'].includes(
          (norm.language || '').toLowerCase()
        )
        ? 'hi'
        : 'en';

    const existing = payrollId
      ? await Employee.findOne({
          $or: [{ payrollId }, { staffId: payrollId }]
        })
      : null;

    if (existing) {
      existing.payrollId = payrollId || existing.payrollId;
      existing.name = name;
      existing.email = email;
      existing.phone = phone;
      existing.language = language;
      existing.active = true;
      existing.source = 'import';
      existing.updatedBy = req.user.id;

      await existing.save();
    } else {
      const staffId = await nextDirectoryId('employee', 'EMP');

      await Employee.create({
        staffId,
        payrollId: payrollId || undefined,
        name,
        email,
        phone,
        language,
        active: true,
        source: 'import',
        updatedBy: req.user.id
      });
    }

    upserted++;
  }

  await audit(
    req,
    'employee.directory.imported',
    'employee-directory',
    '',
    'success',
    { rows: rows.length, upserted, rejected }
  );

  res.json({ rows: rows.length, upserted, rejected });
});

router.patch('/employees/:id', async (req, res) => {
  const allowed = [
    'name',
    'email',
    'phone',
    'language',
    'active',
    'payrollId'
  ];

  const update = {};

  for (const key of allowed) {
    if (Object.hasOwn(req.body || {}, key)) {
      update[key] = req.body[key];
    }
  }

  if (
    update.language !== undefined &&
    !['en', 'mr', 'hi'].includes(update.language)
  ) {
    return res.status(400).json({
      error: 'Language must be en, mr or hi'
    });
  }

  if (update.email !== undefined) {
    update.email = String(update.email).trim().toLowerCase();

    if (!isValidEmail(update.email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
  }

  if (update.phone !== undefined) {
    const raw = String(update.phone || '').trim();
    update.phone = normalizePhone(raw);

    if (raw && !update.phone) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
  }

  if (update.payrollId !== undefined) {
    update.payrollId = String(update.payrollId || '')
      .trim()
      .toUpperCase();
  }

  update.updatedBy = req.user.id;

  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    { $set: update },
    { new: true, runValidators: true }
  );

  if (!employee) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  await audit(
    req,
    'employee.updated',
    'employee',
    employee._id,
    'success',
    { staffId: employee.staffId }
  );

  res.json({ employee });
});

// Miscellaneous contacts

router.get('/miscellaneous', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const filter = directoryQuery(req.query.q);

  const [items, total] = await Promise.all([
    MiscellaneousContact.find(filter)
      .sort({ staffId: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    MiscellaneousContact.countDocuments(filter)
  ]);

  res.json({ items, page, limit, total });
});

router.post('/miscellaneous', async (req, res) => {
  const name = String(req.body?.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'Contact name is required' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const rawPhone = String(req.body?.phone || '').trim();
  const phone = normalizePhone(rawPhone);

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (rawPhone && !phone) {
    return res.status(400).json({
      error: 'Mobile number must be a valid international number or a 10-digit Indian mobile number'
    });
  }

  const language = ['en', 'mr', 'hi'].includes(req.body?.language)
    ? req.body.language
    : 'en';

  const staffId = await nextDirectoryId('miscellaneous', 'MISC');

  const contact = await MiscellaneousContact.create({
    staffId,
    name,
    organization: String(req.body?.organization || '').trim().slice(0, 200),
    email,
    phone,
    language,
    notes: String(req.body?.notes || '').trim().slice(0, 1000),
    updatedBy: req.user.id
  });

  await audit(
    req,
    'miscellaneous_contact.created',
    'miscellaneous-contact',
    contact._id,
    'success',
    { staffId }
  );

  res.status(201).json({ contact });
});

router.patch('/miscellaneous/:id', async (req, res) => {
  const contact = await MiscellaneousContact.findById(req.params.id);

  if (!contact) {
    return res.status(404).json({
      error: 'Miscellaneous contact not found'
    });
  }

  if (Object.hasOwn(req.body || {}, 'active')) {
    contact.active = Boolean(req.body.active);
  }

  if (Object.hasOwn(req.body || {}, 'notes')) {
    contact.notes = String(req.body.notes || '').slice(0, 1000);
  }

  contact.updatedBy = req.user.id;
  await contact.save();

  await audit(
    req,
    'miscellaneous_contact.updated',
    'miscellaneous-contact',
    contact._id,
    'success',
    { staffId: contact.staffId, active: contact.active }
  );

  res.json({ contact });
});

// Bills

router.get('/bills', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const q = String(req.query.q || '').trim();

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(escaped, 'i');

  const filter = q
    ? {
        $or: [
          { reference: rx },
          { title: rx },
          { recipientName: rx },
          { recipientEmail: rx },
          { organization: rx }
        ]
      }
    : {};

  const [items, total] = await Promise.all([
    Bill.find(filter)
      .select('-attachmentPath')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Bill.countDocuments(filter)
  ]);

  res.json({ items, page, limit, total });
});

router.post('/bills', async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const recipientName = String(req.body?.recipientName || '').trim();
  const recipientEmail = String(req.body?.recipientEmail || '')
    .trim()
    .toLowerCase();

  const amount = Number(req.body?.amount);

  if (
    !title ||
    !recipientName ||
    !isValidEmail(recipientEmail) ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    return res.status(400).json({
      error: 'Bill title, recipient name, valid recipient email and non-negative amount are required'
    });
  }

  const issueDate = req.body?.issueDate
    ? new Date(req.body.issueDate)
    : undefined;

  const dueDate = req.body?.dueDate
    ? new Date(req.body.dueDate)
    : undefined;

  if (
    (issueDate && !Number.isFinite(issueDate.getTime())) ||
    (dueDate && !Number.isFinite(dueDate.getTime()))
  ) {
    return res.status(400).json({ error: 'Invalid bill date' });
  }

  const reference = `SGGS-BILL-${new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const bill = await Bill.create({
    reference,
    billNumber: String(req.body?.billNumber || '').trim().slice(0, 100),
    title,
    recipientName,
    recipientEmail,
    organization: String(req.body?.organization || '').trim().slice(0, 200),
    amount: amount.toFixed(2),
    issueDate,
    dueDate,
    notes: String(req.body?.notes || '').trim().slice(0, 2000),
    createdBy: req.user.id,
    updatedBy: req.user.id
  });

  await audit(
    req,
    'bill.created',
    'bill',
    bill._id,
    'success',
    { reference: bill.reference, amount: amount.toFixed(2) }
  );

  res.status(201).json({ bill });
});

router.post('/bills/:id/send', async (req, res) => {
  const bill = await Bill.findById(req.params.id).select('+attachmentPath');

  if (!bill) {
    return res.status(404).json({ error: 'Bill not found' });
  }

  if (bill.status === 'sent') {
    return res.status(409).json({
      error: 'This bill has already been sent'
    });
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    return res.status(503).json({
      error: 'SMTP is not configured. Set SMTP_HOST and SMTP_FROM.'
    });
  }

  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          }
        : undefined
    });

    const money = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR'
    }).format(Number(bill.amount));

    const text = [
      `Dear ${bill.recipientName},`,
      '',
      `Bill reference: ${bill.reference}`,
      `Bill number: ${bill.billNumber || '—'}`,
      `Purpose: ${bill.title}`,
      `Organization: ${bill.organization || '—'}`,
      `Amount: ${money}`,
      `Issue date: ${bill.issueDate ? bill.issueDate.toLocaleDateString('en-IN') : '—'}`,
      `Due date: ${bill.dueDate ? bill.dueDate.toLocaleDateString('en-IN') : '—'}`,
      bill.notes ? `Notes: ${bill.notes}` : '',
      '',
      'Regards,',
      'SGGS Nanded'
    ].filter(Boolean).join('\n');

    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: bill.recipientEmail,
      subject: `Bill ${bill.reference}: ${bill.title}`,
      text
    });

    bill.status = 'sent';
    bill.sentAt = new Date();
    bill.lastError = '';
    bill.updatedBy = req.user.id;

    await bill.save();

    await audit(
      req,
      'bill.sent',
      'bill',
      bill._id,
      'success',
      {
        reference: bill.reference,
        recipientEmail: bill.recipientEmail
      }
    );

    res.json({ bill });
  } catch (error) {
    bill.status = 'failed';
    bill.lastError = String(error.message || 'Email send failed').slice(0, 500);
    bill.updatedBy = req.user.id;

    await bill.save();

    await audit(
      req,
      'bill.send_failed',
      'bill',
      bill._id,
      'failure',
      {
        reference: bill.reference,
        error: bill.lastError
      }
    );

    res.status(502).json({
      error: `Bill email failed: ${bill.lastError}`
    });
  }
});

// Notification templates

router.get('/templates', async (req, res) => {
  const items = await Template.find(
    req.query.all === 'true' ? {} : { status: 'published' }
  )
    .sort({ key: 1, channel: 1, language: 1, version: -1 })
    .limit(1000)
    .lean();

  res.json({ items });
});

router.post('/templates', async (req, res) => {
  const {
    key = 'salary_notification',
    channel,
    language,
    subject = '',
    body,
    whatsappTemplateName = '',
    whatsappLanguageCode = ''
  } = req.body || {};

  if (
    !['email', 'sms', 'whatsapp'].includes(channel) ||
    !['en', 'mr', 'hi'].includes(language) ||
    typeof body !== 'string' ||
    !body.trim()
  ) {
    return res.status(400).json({
      error: 'Valid channel, language and body are required'
    });
  }

  if (channel === 'whatsapp' && !String(whatsappTemplateName).trim()) {
    return res.status(400).json({
      error: 'An approved WhatsApp template name is required'
    });
  }

  if (body.length > 5000 || String(subject).length > 200) {
    return res.status(400).json({
      error: 'Template content is too long'
    });
  }

  if (
    channel === 'whatsapp' &&
    whatsappLanguageCode &&
    !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(String(whatsappLanguageCode))
  ) {
    return res.status(400).json({
      error: 'WhatsApp language code must look like en_US, mr or hi'
    });
  }

  const allowedPlaceholders = new Set([
    'employee_name',
    'staff_id',
    'salary_amount',
    'salary_period',
    'campaign_title',
    'college_name',
    'notification_date'
  ]);

  const usedPlaceholders = [
    ...body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)
  ].map(match => match[1]);

  const unknownPlaceholder = usedPlaceholders.find(
    placeholder => !allowedPlaceholders.has(placeholder)
  );

  if (unknownPlaceholder) {
    return res.status(400).json({
      error: `Unsupported template placeholder: ${unknownPlaceholder}`
    });
  }

  const previous = await Template.find({
    key,
    channel,
    language
  })
    .sort({ version: -1 })
    .limit(1)
    .lean();

  const template = await Template.create({
    key,
    channel,
    language,
    version: (previous[0]?.version || 0) + 1,
    subject: String(subject),
    body,
    whatsappTemplateName: String(whatsappTemplateName),
    whatsappLanguageCode: String(whatsappLanguageCode),
    status: 'draft',
    editedBy: req.user.id
  });

  await audit(
    req,
    'template.version.created',
    'template',
    template._id,
    'success',
    { key, channel, language, version: template.version }
  );

  res.status(201).json({ template });
});

router.post('/templates/:id/restore', async (req, res) => {
  const source = await Template.findById(req.params.id);

  if (!source) {
    return res.status(404).json({ error: 'Template version not found' });
  }

  const latest = await Template.find({
    key: source.key,
    channel: source.channel,
    language: source.language
  })
    .sort({ version: -1 })
    .limit(1)
    .lean();

  const item = await Template.create({
    key: source.key,
    channel: source.channel,
    language: source.language,
    version: (latest[0]?.version || 0) + 1,
    subject: source.subject,
    body: source.body,
    whatsappTemplateName: source.whatsappTemplateName,
    whatsappLanguageCode: source.whatsappLanguageCode,
    status: 'draft',
    editedBy: req.user.id
  });

  await audit(
    req,
    'template.version.restored_as_draft',
    'template',
    item._id,
    'success',
    {
      sourceVersion: source.version,
      newVersion: item.version,
      channel: item.channel,
      language: item.language
    }
  );

  res.status(201).json({ template: item });
});

router.post('/templates/:id/publish', async (req, res) => {
  const template = await Template.findById(req.params.id);

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  if (template.channel === 'whatsapp' && !template.whatsappTemplateName) {
    return res.status(400).json({
      error: 'Approved WhatsApp template name is required'
    });
  }

  await Template.updateMany(
    {
      key: template.key,
      channel: template.channel,
      language: template.language,
      status: 'published'
    },
    { $set: { status: 'archived' } }
  );

  template.status = 'published';
  template.publishedAt = new Date();

  await template.save();

  await audit(
    req,
    'template.published',
    'template',
    template._id,
    'success',
    {
      key: template.key,
      channel: template.channel,
      language: template.language,
      version: template.version
    }
  );

  res.json({ template });
});

// Website image assets

router.post(
  '/site-assets',
  assetLimiter,
  assetUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Select an image file' });
      }

      const meta = await sharp(req.file.buffer, {
        failOn: 'error'
      }).metadata();

      if (!['jpeg', 'png', 'webp'].includes(meta.format)) {
        return res.status(400).json({
          error: 'Only JPEG, PNG and WebP images are accepted. SVG is not allowed.'
        });
      }

      if (
        !meta.width ||
        !meta.height ||
        meta.width > 10000 ||
        meta.height > 10000
      ) {
        return res.status(400).json({
          error: 'Image dimensions are invalid or too large'
        });
      }

      const name = `${crypto.randomUUID()}.webp`;

      await sharp(req.file.buffer)
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 84 })
        .toFile(path.join(assetDir, name));

      await audit(
        req,
        'site-asset.uploaded',
        'site-asset',
        name,
        'success',
        { bytes: req.file.size, format: meta.format }
      );

      res.status(201).json({ url: `/site-assets/${name}`, name });
    } catch (error) {
      next(error);
    }
  }
);

// Website content management

router.get('/site-content/versions', async (req, res) => {
  const filter = req.query.key
    ? { key: String(req.query.key).slice(0, 80) }
    : {};

  const items = await SiteContent.find(filter)
    .sort({ key: 1, version: -1 })
    .limit(500)
    .lean();

  res.json({ items });
});

router.post('/site-content/versions/:id/restore', async (req, res) => {
  const source = await SiteContent.findById(req.params.id);

  if (!source) {
    return res.status(404).json({ error: 'Content version not found' });
  }

  const latest = await SiteContent.find({ key: source.key })
    .sort({ version: -1 })
    .limit(1)
    .lean();

  const item = await SiteContent.create({
    key: source.key,
    version: (latest[0]?.version || 0) + 1,
    status: 'draft',
    content: source.content,
    editedBy: req.user.id
  });

  await audit(
    req,
    'site-content.version.restored_as_draft',
    'site-content',
    item._id,
    'success',
    {
      sourceVersion: source.version,
      newVersion: item.version,
      key: item.key
    }
  );

  res.status(201).json({ item });
});

router.get('/site-content', async (_req, res) => {
  const items = await SiteContent.find({
    status: { $ne: 'archived' }
  })
    .sort({ key: 1, version: -1 })
    .lean();

  const latest = {};

  for (const item of items) {
    if (!latest[item.key] || item.version > latest[item.key].version) {
      latest[item.key] = item;
    }
  }

  res.json({ content: latest });
});

router.put('/site-content/:key', async (req, res) => {
  const key = String(req.params.key || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);

  const content = req.body?.content;

  if (
    !key ||
    !content ||
    typeof content !== 'object' ||
    JSON.stringify(content).length > 100000
  ) {
    return res.status(400).json({
      error: 'Valid content object under 100 KB is required'
    });
  }

  const previous = await SiteContent.find({ key })
    .sort({ version: -1 })
    .limit(1)
    .lean();

  const item = await SiteContent.create({
    key,
    version: (previous[0]?.version || 0) + 1,
    status: 'draft',
    content,
    editedBy: req.user.id
  });

  await audit(
    req,
    'site-content.draft.created',
    'site-content',
    item._id,
    'success',
    { key, version: item.version }
  );

  res.status(201).json({ item });
});

router.post('/site-content/:id/publish', async (req, res) => {
  const item = await SiteContent.findById(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'Content version not found' });
  }

  await SiteContent.updateMany(
    { key: item.key, status: 'published' },
    { $set: { status: 'archived' } }
  );

  item.status = 'published';
  item.publishedAt = new Date();

  await item.save();

  await audit(
    req,
    'site-content.published',
    'site-content',
    item._id,
    'success',
    { key: item.key, version: item.version }
  );

  res.json({ item });
});

// System settings

router.get('/settings', async (_req, res) => {
  const settings = await SystemSetting.find().lean();

  res.json({
    settings: Object.fromEntries(
      settings.map(setting => [setting.key, setting.value])
    )
  });
});

router.patch('/settings/:key', async (req, res) => {
  const allowed = new Set([
    'site',
    'uploadPolicy',
    'retentionPolicy',
    'approvalPolicy',
    'notificationPolicy',
    'reportPolicy',
    'localePolicy',
    'costLimits',
    'providerPricing'
  ]);

  const key = String(req.params.key);

  if (!allowed.has(key)) {
    return res.status(400).json({
      error: 'This setting cannot be changed through this endpoint'
    });
  }

  const value = req.body?.value;

  if (
    value === undefined ||
    JSON.stringify(value).length > 50000 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return res.status(400).json({
      error: 'A JSON object setting under 50 KB is required'
    });
  }

  if (key === 'uploadPolicy') {
    const hardLimit = Number(process.env.MAX_UPLOAD_MB || 20);

    if (
      value.maxUploadMB !== undefined &&
      (
        !Number.isFinite(Number(value.maxUploadMB)) ||
        Number(value.maxUploadMB) < 1 ||
        Number(value.maxUploadMB) > hardLimit
      )
    ) {
      return res.status(400).json({
        error: `maxUploadMB must be between 1 and the server hard limit (${hardLimit} MB)`
      });
    }

    if (
      value.maxRecipientsPerCampaign !== undefined &&
      (
        !Number.isInteger(Number(value.maxRecipientsPerCampaign)) ||
        Number(value.maxRecipientsPerCampaign) < 1 ||
        Number(value.maxRecipientsPerCampaign) > 1000
      )
    ) {
      return res.status(400).json({
        error: 'maxRecipientsPerCampaign must be an integer between 1 and 1000'
      });
    }

    if (
      value.maxRowsPerUpload !== undefined &&
      (
        !Number.isInteger(Number(value.maxRowsPerUpload)) ||
        Number(value.maxRowsPerUpload) < 1 ||
        Number(value.maxRowsPerUpload) > 1000
      )
    ) {
      return res.status(400).json({
        error: 'maxRowsPerUpload must be an integer between 1 and 1000'
      });
    }
  }

  if (key === 'retentionPolicy') {
    for (const field of [
      'uploadRetentionDays',
      'backupRetentionDays',
      'salaryDataRetentionDays'
    ]) {
      if (
        value[field] !== undefined &&
        (
          !Number.isInteger(Number(value[field])) ||
          Number(value[field]) < 1 ||
          Number(value[field]) > 3650
        )
      ) {
        return res.status(400).json({
          error: `${field} must be an integer between 1 and 3650`
        });
      }
    }
  }

  if (
    key === 'reportPolicy' &&
    value.retentionDays !== undefined &&
    (
      !Number.isInteger(Number(value.retentionDays)) ||
      Number(value.retentionDays) < 1 ||
      Number(value.retentionDays) > 365
    )
  ) {
    return res.status(400).json({
      error: 'Report retention must be between 1 and 365 days'
    });
  }

  if (key === 'notificationPolicy') {
    const channels = ['email', 'sms', 'whatsapp'];

    if (
      value.enabledChannels !== undefined &&
      (
        !Array.isArray(value.enabledChannels) ||
        !value.enabledChannels.length ||
        value.enabledChannels.some(channel => !channels.includes(channel))
      )
    ) {
      return res.status(400).json({
        error: 'enabledChannels must contain one or more supported channels'
      });
    }

    if (value.requireAdminApproval === false) {
      return res.status(400).json({
        error: 'Administrator approval is mandatory and cannot be disabled'
      });
    }
  }

  if (key === 'providerPricing') {
    for (const field of [
      'emailCostPerMessage',
      'smsCostPerSegment',
      'whatsappCostPerMessage'
    ]) {
      if (
        value[field] !== undefined &&
        (
          !Number.isFinite(Number(value[field])) ||
          Number(value[field]) < 0 ||
          Number(value[field]) > 1000000
        )
      ) {
        return res.status(400).json({
          error: `${field} must be a non-negative cost amount`
        });
      }
    }
  }

  if (key === 'costLimits') {
    for (const field of ['maxCampaignCostINR', 'monthlyBudgetINR']) {
      if (
        value[field] !== undefined &&
        (
          !Number.isFinite(Number(value[field])) ||
          Number(value[field]) < 0 ||
          Number(value[field]) > 1000000000
        )
      ) {
        return res.status(400).json({
          error: `${field} must be a non-negative INR amount`
        });
      }
    }
  }

  if (key === 'localePolicy') {
    const languages = ['en', 'mr', 'hi'];

    if (
      value.defaultLanguage !== undefined &&
      !languages.includes(value.defaultLanguage)
    ) {
      return res.status(400).json({
        error: 'Unsupported default language'
      });
    }

    if (
      value.supportedLanguages !== undefined &&
      (
        !Array.isArray(value.supportedLanguages) ||
        !value.supportedLanguages.length ||
        value.supportedLanguages.some(language => !languages.includes(language))
      )
    ) {
      return res.status(400).json({
        error: 'supportedLanguages must use en, mr and/or hi'
      });
    }
  }

  const setting = await SystemSetting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy: req.user.id } },
    { upsert: true, new: true }
  );

  invalidateSetting(key);

  await audit(
    req,
    'system-setting.updated',
    'system-setting',
    setting._id,
    'success',
    { key }
  );

  res.json({ setting });
});

// Audit history

router.get('/audit-logs', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const filter = {};

  if (req.query.action) {
    filter.action = String(req.query.action).slice(0, 100);
  }

  if (req.query.result) {
    filter.result = String(req.query.result);
  }

  if (req.query.from || req.query.to) {
    filter.createdAt = {
      ...(req.query.from ? { $gte: new Date(req.query.from) } : {}),
      ...(req.query.to ? { $lte: new Date(req.query.to) } : {})
    };
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter)
  ]);

  res.json({ items, page, limit, total });
});

// Usage and provider costs

router.get('/usage', async (req, res) => {
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(Date.now() - 30 * 86400000);

  const to = req.query.to ? new Date(req.query.to) : new Date();

  const usage = await UsageRecord.aggregate([
    {
      $match: {
        occurredAt: { $gte: from, $lte: to }
      }
    },
    {
      $group: {
        _id: {
          provider: '$provider',
          channel: '$channel',
          currency: '$currency'
        },
        units: { $sum: '$units' },
        estimatedCost: { $sum: '$estimatedCost' },
        actualCost: { $sum: '$actualCost' }
      }
    },
    { $sort: { '_id.channel': 1 } }
  ]);

  res.json({ from, to, usage });
});

router.patch('/deliveries/:id/reconcile', async (req, res) => {
  const status = String(req.body?.status || '');

  if (!['delivered', 'sent', 'failed', 'queued'].includes(status)) {
    return res.status(400).json({
      error: 'Status must be delivered, sent, failed, or queued after provider reconciliation'
    });
  }

  const job = await DeliveryJob.findById(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Delivery job not found' });
  }

  if (!['unknown', 'failed', 'sent'].includes(job.status)) {
    return res.status(409).json({
      error: 'Only unknown, failed or sent jobs can be manually reconciled'
    });
  }

  if (status === 'queued' && !req.body?.confirmNotSent) {
    return res.status(400).json({
      error: 'Set confirmNotSent=true only after verifying the provider did not accept the message'
    });
  }

  job.status = status;

  if (req.body?.providerMessageId) {
    job.providerMessageId = String(req.body.providerMessageId).slice(0, 200);
  }

  if (status === 'delivered') job.deliveredAt = new Date();
  if (status === 'sent') job.acceptedAt = new Date();

  if (status === 'queued') {
    job.nextAttemptAt = new Date();
    job.lastError = undefined;
    job.lastErrorCode = undefined;
  }

  await job.save();

  if (status === 'queued') {
    await getNotificationQueue().add(
      'send-delivery',
      { deliveryJobId: String(job._id) },
      {
        jobId: `delivery-reconcile-${job._id}-${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30000 }
      }
    );
  }

  await recalculateCampaign(job.campaign);

  await audit(
    req,
    'delivery.manually_reconciled',
    'delivery-job',
    job._id,
    'success',
    {
      status,
      channel: job.channel,
      providerMessageId: job.providerMessageId
    }
  );

  res.json({
    job: {
      id: job._id,
      status: job.status,
      providerMessageId: job.providerMessageId
    }
  });
});

router.get('/usage/records', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));

  const items = await UsageRecord.find()
    .sort({ occurredAt: -1 })
    .limit(limit)
    .lean();

  res.json({ items });
});

router.patch('/usage/:id/reconcile', async (req, res) => {
  const actualCost = Number(req.body?.actualCost);

  if (
    !Number.isFinite(actualCost) ||
    actualCost < 0 ||
    actualCost > 100000000
  ) {
    return res.status(400).json({
      error: 'Actual cost must be a non-negative INR amount'
    });
  }

  const item = await UsageRecord.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        actualCost,
        reconciliationStatus: 'reconciled',
        currency: 'INR'
      }
    },
    { new: true }
  );

  if (!item) {
    return res.status(404).json({ error: 'Usage record not found' });
  }

  await audit(
    req,
    'provider-usage.reconciled',
    'usage-record',
    item._id,
    'success',
    {
      channel: item.channel,
      provider: item.provider,
      actualCost
    }
  );

  res.json({ item });
});

// Provider connection testing

router.post('/providers/:provider/test', async (req, res) => {
  const provider = String(req.params.provider).toLowerCase();

  try {
    let result;

    if (provider === 'email') {
      result = await testEmailProvider();
    } else if (provider === 'sms') {
      result = await testSmsProvider();
    } else if (provider === 'whatsapp') {
      result = await testWhatsAppProvider();
    } else {
      return res.status(400).json({
        error: 'Provider must be email, sms or whatsapp'
      });
    }

    await audit(
      req,
      'provider.connection_test',
      'provider',
      provider,
      'success',
      { configured: true }
    );

    res.json({
      ok: true,
      provider,
      details: typeof result === 'object'
        ? {
            accountSid: result.sid,
            displayPhoneNumber: result.display_phone_number,
            verifiedName: result.verified_name
          }
        : { verified: true }
    });
  } catch (error) {
    await audit(
      req,
      'provider.connection_test',
      'provider',
      provider,
      'failure',
      { message: String(error.message || '').slice(0, 200) }
    );

    res.status(400).json({
      error: `Provider test failed: ${String(error.message || 'Unknown error').slice(0, 300)}`
    });
  }
});

router.get('/provider-health', async (_req, res) => {
  res.json({
    providers: [
      {
        channel: 'email',
        configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
        mode: 'SMTP',
        note: 'Credentials are supplied through server environment/secret manager.'
      },
      {
        channel: 'sms',
        configured: Boolean(
          process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          process.env.TWILIO_SMS_FROM
        ),
        mode: 'Twilio SMS',
        note: 'Confirm regional sender and compliance requirements.'
      },
      {
        channel: 'whatsapp',
        configured: Boolean(
          process.env.WHATSAPP_PHONE_NUMBER_ID &&
          process.env.WHATSAPP_ACCESS_TOKEN &&
          process.env.WHATSAPP_APP_SECRET &&
          process.env.WHATSAPP_GRAPH_VERSION
        ),
        mode: 'WhatsApp Cloud API',
        note: 'Approved message templates and business verification are required.'
      }
    ]
  });
});

// Encrypted backups

router.get('/backups', async (_req, res) => {
  const items = await BackupRecord.find()
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({ items });
});

router.post('/backups', backupLimiter, async (req, res, next) => {
  try {
    if (!process.env.BACKUP_ENCRYPTION_PASSPHRASE) {
      return res.status(503).json({
        error: 'Encrypted backup is not configured. Set BACKUP_ENCRYPTION_PASSPHRASE in the server secret store.'
      });
    }

    const retention = (
      await SystemSetting.findOne({ key: 'retentionPolicy' }).lean()
    )?.value || {};

    const record = await BackupRecord.create({
      reference: `SGGS-BKP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      provider: 'encrypted-mongodump-and-private-files',
      status: 'requested',
      createdBy: req.user.id,
      expiresAt: new Date(
        Date.now() +
        Number(
          retention.backupRetentionDays ||
          process.env.BACKUP_RETENTION_DAYS ||
          35
        ) * 86400000
      )
    });

    try {
      await getBackupQueue().add(
        'create-backup',
        { backupId: String(record._id) },
        {
          jobId: `backup-${record._id}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 10000 }
        }
      );
    } catch (error) {
      record.status = 'failed';
      record.error = 'Could not enqueue backup job';
      await record.save();
      throw error;
    }

    await audit(
      req,
      'backup.requested',
      'backup',
      record._id,
      'success',
      { reference: record.reference }
    );

    res.status(202).json({
      backup: record,
      message: 'Encrypted backup queued. Check its status in the backup list.'
    });
  } catch (error) {
    next(error);
  }
});

router.post('/backups/:id/verify', async (req, res, next) => {
  try {
    const record = await verifyEncryptedBackup(req.params.id);

    await audit(req, 'backup.verified', 'backup', record._id);

    res.json({ backup: record });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/backups/:id/download', async (req, res) => {
  const record = await BackupRecord.findById(req.params.id)
    .select('+storageReference');

  if (
    !record ||
    !record.storageReference ||
    !['completed', 'verified'].includes(record.status)
  ) {
    return res.status(404).json({
      error: 'Verified backup file not found'
    });
  }

  const dir = getBackupDirectory();
  const file = path.resolve(record.storageReference);

  if (path.dirname(file) !== dir) {
    return res.status(500).json({
      error: 'Invalid backup storage reference'
    });
  }

  await audit(
    req,
    'backup.downloaded',
    'backup',
    record._id,
    'success',
    { reference: record.reference }
  );

  res.download(file, `${record.reference}.sggsbackup`);
});

router.post('/backups/:id/restore', async (req, res) => {
  await audit(
    req,
    'backup.restore.requested',
    'backup',
    req.params.id,
    'denied',
    {
      reason: 'Online restore is disabled to prevent overwriting the live database without maintenance mode.'
    }
  );

  res.status(409).json({
    error: 'Live restore is a controlled maintenance operation. Stop application traffic and run scripts/restore.sh using the approved encrypted backup, then verify the application before reopening traffic.'
  });
});

export default router;