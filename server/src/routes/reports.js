import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ReportJob, ReportDownload, Campaign } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { getReportQueue } from '../services/queue.js';
import { createReportJob } from '../services/reportGenerator.js';
import { audit } from '../utils/audit.js';

const router = Router();

router.use(requireRole('admin'));

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Report generation limit reached. Try again later.' }
});

router.param('id', (req, res, next, value) =>
  mongoose.Types.ObjectId.isValid(value)
    ? next()
    : res.status(404).json({ error: 'Resource not found' })
);

const allowedTypes = [
  'campaign-pdf',
  'deliveries-xlsx',
  'deliveries-csv',
  'uploads-pdf',
  'uploads-csv',
  'audit-csv',
  'operations-pdf'
];

function normalizeDate(value, label, endOfDay = false) {
  if (value === undefined || value === null || value === '') return undefined;

  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    const error = new Error(`${label} must be a valid date`);
    error.status = 400;
    throw error;
  }

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date.toISOString();
}

router.post('/', reportLimiter, async (req, res, next) => {
  try {
    const type = String(req.body?.type || 'campaign-pdf');

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Unsupported report type' });
    }

    if (
      ['audit-csv', 'operations-pdf'].includes(type) &&
      req.user.role !== 'admin'
    ) {
      return res.status(403).json({ error: 'This report type is admin-only' });
    }

    const requestedFilters =
      req.body?.filters && typeof req.body.filters === 'object'
        ? req.body.filters
        : {};

    const filters = {
      ...requestedFilters,
      from: normalizeDate(requestedFilters.from, 'Start date'),
      to: normalizeDate(requestedFilters.to, 'End date', true)
    };

    if (filters.from && filters.to && filters.from > filters.to) {
      return res.status(400).json({
        error: 'Start date must be before or equal to end date'
      });
    }

    if (filters.campaignId) {
      if (!mongoose.Types.ObjectId.isValid(filters.campaignId)) {
        return res.status(400).json({ error: 'Invalid campaignId' });
      }

      const campaign = await Campaign.findOne({
        _id: filters.campaignId
      }).select('_id').lean();

      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
    } else if (type === 'campaign-pdf') {
      return res.status(400).json({
        error: 'campaignId is required for campaign PDF reports'
      });
    }

    const job = await createReportJob({
      requestedBy: req.user.id,
      requesterRole: req.user.role,
      type,
      filters
    });

    try {
      await getReportQueue().add(
        'generate-report',
        { reportId: String(job._id) },
        {
          jobId: `report-${job._id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 }
        }
      );
    } catch (error) {
      job.status = 'failed';
      job.error = 'Could not enqueue report generation';
      await job.save();
      throw error;
    }

    await audit(req, 'report.requested', 'report', job._id, 'success', {
      type,
      filters
    });

    res.status(202).json({
      report: {
        id: job._id,
        reference: job.reference,
        type,
        status: job.status,
        expiresAt: job.expiresAt
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/my', async (req, res) => {
  const items = await ReportJob.find({ requestedBy: req.user.id })
    .select('-storagePath')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({ items });
});

router.get('/download-history', async (_req, res) => {
  const items = await ReportDownload.find()
    .sort({ downloadedAt: -1 })
    .limit(200)
    .lean();

  res.json({ items });
});

router.get('/admin/all', requireRole('admin'), async (_req, res) => {
  const items = await ReportJob.find()
    .select('-storagePath')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  res.json({ items });
});

router.get('/:id', async (req, res) => {
  const report = await ReportJob.findOne({
    _id: req.params.id
  }).select('-storagePath').lean();

  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  res.json({ report });
});

router.delete('/:id', async (req, res) => {
  const report = await ReportJob.findById(req.params.id).select('+storagePath');
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.storagePath) await fs.unlink(report.storagePath).catch(() => {});
  await ReportDownload.deleteMany({ report: report._id });
  await ReportJob.deleteOne({ _id: report._id });
  await audit(req, 'report.deleted', 'report', report._id, 'success', { reference: report.reference });
  return res.json({ ok: true });
});

router.get('/:id/download', async (req, res) => {
  const report = await ReportJob.findOne({
    _id: req.params.id
  }).select('+storagePath');

  if (!report) {
    await ReportDownload.create({
      report: req.params.id,
      actorId: String(req.user.id),
      actorRole: req.user.role,
      result: 'denied',
      requestId: req.id
    });

    return res.status(404).json({ error: 'Report not found' });
  }

  if (report.status !== 'ready' || !report.storagePath) {
    return res.status(409).json({ error: `Report is ${report.status}` });
  }

  if (report.expiresAt && report.expiresAt <= new Date()) {
    report.status = 'expired';
    await report.save();
    return res.status(410).json({ error: 'Report has expired' });
  }

  const reportDir = path.resolve(
    process.env.PRIVATE_REPORT_DIR || './server/private-reports'
  );

  if (path.dirname(path.resolve(report.storagePath)) !== reportDir) {
    return res.status(500).json({ error: 'Invalid report storage reference' });
  }

  try {
    await fs.access(report.storagePath);
  } catch {
    return res.status(404).json({ error: 'Report file is unavailable' });
  }

  await ReportDownload.create({
    report: report._id,
    actorId: String(req.user.id),
    actorRole: req.user.role,
    result: 'success',
    requestId: req.id
  });

  report.downloadedAt = new Date();
  report.downloadCount += 1;
  await report.save();

  await audit(
    req,
    'report.downloaded',
    'report',
    report._id,
    'success',
    { reference: report.reference, type: report.type }
  );

  const ext = path.extname(report.storagePath);
  res.download(report.storagePath, `${report.reference}${ext}`);
});

export default router;