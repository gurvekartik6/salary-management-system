import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import {
  Campaign,
  DeliveryJob,
  AuditLog,
  ReportJob,
  UsageRecord,
  SystemSetting,
  Upload,
  Bill
} from '../models/index.js';

const devanagariFont = fileURLToPath(
  new URL('../../assets/fonts/NotoSansDevanagariUI-Regular.ttf', import.meta.url)
);

const latinFont = fileURLToPath(
  new URL('../../assets/fonts/NotoSans-Regular.ttf', import.meta.url)
);

const fontFor = value =>
  /[\u0900-\u097F]/.test(String(value ?? '')) ? 'SGGSUnicode' : 'SGGSLatin';

const reportDir = path.resolve(process.env.PRIVATE_REPORT_DIR || './server/private-reports');

await fs.mkdir(reportDir, { recursive: true, mode: 0o700 });
await fs.chmod(reportDir, 0o700).catch(() => {});

const safeCsv = value => {
  const string = String(value ?? '');
  return /^[=+\-@\t\r]/.test(string) ? `'${string}` : string;
};

function makeRef() {
  return `SGGS-RPT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function pdfToFile(filePath, title, rows, subtitle = '') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: title,
        Author: 'SGGS Salary Notification System'
      }
    });

    const stream = createWriteStream(filePath, { mode: 0o600 });

    stream.on('error', reject);
    stream.on('finish', resolve);
    doc.on('error', reject);

    doc.registerFont('SGGSUnicode', devanagariFont);
    doc.registerFont('SGGSLatin', latinFont);
    doc.font('SGGSLatin');
    doc.pipe(stream);

    doc.fontSize(17).text('SGGS Salary Notification System');
    doc.moveDown(0.3).fontSize(14).text(title);

    doc.moveDown(0.2)
      .fontSize(9)
      .fillColor('#555')
      .font(fontFor(subtitle))
      .text(
        subtitle ||
        `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      );

    doc.moveDown().fillColor('#111').fontSize(10);

    for (const [label, value] of rows) {
      if (doc.y > 735) doc.addPage();

      doc.font(fontFor(label)).text(`${label}: `, { continued: true });
      doc.font(fontFor(value)).text(String(value ?? '—'));
      doc.moveDown(0.35);
    }

    doc.end();
  });
}

export async function createReportJob({
  requestedBy,
  requesterRole,
  type,
  filters = {}
}) {
  const reportPolicy =
    (await SystemSetting.findOne({ key: 'reportPolicy' }).lean())?.value || {};

  const retentionDays = Number(
    reportPolicy.retentionDays ||
    process.env.REPORT_RETENTION_DAYS ||
    30
  );

  return ReportJob.create({
    reference: makeRef(),
    requestedBy,
    requesterRole,
    type,
    filters,
    status: 'queued',
    expiresAt: new Date(Date.now() + Math.max(1, retentionDays) * 86400000)
  });
}

export async function generateReport(reportId) {
  const report = await ReportJob.findById(reportId);

  if (!report) throw new Error('Report request not found');

  if (report.expiresAt && report.expiresAt <= new Date()) {
    report.status = 'expired';
    await report.save();
    return report;
  }

  report.status = 'processing';
  await report.save();

  try {
    const extension = report.type.endsWith('pdf')
      ? 'pdf'
      : report.type.endsWith('xlsx')
        ? 'xlsx'
        : 'csv';

    const filePath = path.join(
      reportDir,
      `${report.reference}.${extension}`
    );

    const campaignFilter = {};

    if (report.requesterRole !== 'admin') {
      campaignFilter.owner = report.requestedBy;
    }

    if (report.filters.campaignId) {
      campaignFilter._id = report.filters.campaignId;
    }

    if (report.type === 'campaign-pdf') {
      const campaign = await Campaign.findOne(campaignFilter).lean();

      if (!campaign) throw new Error('Campaign not found or not accessible');

      const campaignUsage = await UsageRecord.aggregate([
        { $match: { campaign: campaign._id } },
        {
          $group: {
            _id: null,
            estimated: { $sum: '$estimatedCost' },
            actual: { $sum: '$actualCost' }
          }
        }
      ]);

      const rows = [
        ['Campaign reference', campaign.reference],
        ['Campaign title', campaign.title],
        ['Version', campaign.version],
        ['Status', campaign.status],
        ['Recipients', campaign.recipients.length],
        ['Channels', campaign.channels.join(', ')],
        ['Created', campaign.createdAt],
        ['Scheduled', campaign.scheduleAt || 'Not scheduled'],
        ['Approved at', campaign.approval?.approvedAt || 'Not approved'],
        ['Total delivery jobs', campaign.counters?.total || 0],
        ['Delivered', campaign.counters?.delivered || 0],
        ['Failed', campaign.counters?.failed || 0],
        [
          'Estimated cost (INR)',
          campaign.estimatedCost ?? campaignUsage[0]?.estimated ?? 0
        ],
        [
          'Actual reconciled cost (INR)',
          campaignUsage[0]?.actual ?? campaign.actualCost ?? 0
        ]
      ];

      await pdfToFile(
        filePath,
        'Campaign Summary Report',
        rows,
        `Report ${report.reference}`
      );
    } else if (
      report.type === 'deliveries-csv' ||
      report.type === 'deliveries-xlsx'
    ) {
      const campaigns = await Campaign.find(campaignFilter)
        .select('_id reference title owner')
        .lean();

      const ids = campaigns.map(campaign => campaign._id);
      const jobsFilter = { campaign: { $in: ids } };

      if (report.filters.from || report.filters.to) {
        jobsFilter.createdAt = {
          ...(report.filters.from
            ? { $gte: new Date(report.filters.from) }
            : {}),
          ...(report.filters.to
            ? { $lte: new Date(report.filters.to) }
            : {})
        };
      }

      const jobs = await DeliveryJob.find(jobsFilter)
        .sort({ createdAt: -1 })
        .limit(100000)
        .lean();

      const campaignMap = new Map(
        campaigns.map(campaign => [String(campaign._id), campaign])
      );

      const rows = jobs.map(job => ({
        campaign: campaignMap.get(String(job.campaign))?.reference || '',
        title: campaignMap.get(String(job.campaign))?.title || '',
        contact: job.destination
          ? `${job.destination.slice(0, 2)}••••${job.destination.slice(-3)}`
          : '',
        channel: job.channel,
        status: job.status,
        attempts: job.attempts,
        providerMessageId: job.providerMessageId || '',
        createdAt: job.createdAt?.toISOString?.() || '',
        acceptedAt: job.acceptedAt?.toISOString?.() || '',
        deliveredAt: job.deliveredAt?.toISOString?.() || '',
        errorCode: job.lastErrorCode || '',
        costINR: job.cost || 0
      }));

      if (report.type === 'deliveries-csv') {
        await fs.writeFile(
          filePath,
          stringify(rows, { header: true, cast: { string: safeCsv } }),
          { mode: 0o600 }
        );
      } else {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Deliveries');

        sheet.columns = Object.keys(
          rows[0] || {
            campaign: '',
            title: '',
            contact: '',
            channel: '',
            status: '',
            attempts: '',
            providerMessageId: '',
            createdAt: '',
            acceptedAt: '',
            deliveredAt: '',
            errorCode: '',
            costINR: ''
          }
        ).map(key => ({
          header: key,
          key,
          width: Math.min(30, Math.max(14, key.length + 2))
        }));

        sheet.addRows(
          rows.map(row =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value === 'string' ? safeCsv(value) : value
              ])
            )
          )
        );

        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        sheet.autoFilter = {
          from: 'A1',
          to: `${String.fromCharCode(64 + sheet.columns.length)}1`
        };

        await workbook.xlsx.writeFile(filePath);
        await fs.chmod(filePath, 0o600);
      }
    } else if (
      report.type === 'uploads-csv' ||
      report.type === 'uploads-pdf'
    ) {
      const uploadFilter = {};

      if (report.requesterRole !== 'admin') {
        uploadFilter.uploadedBy = report.requestedBy;
      }

      if (report.filters.from || report.filters.to) {
        uploadFilter.createdAt = {};
      }

      if (report.filters.from) {
        uploadFilter.createdAt.$gte = new Date(report.filters.from);
      }

      if (report.filters.to) {
        uploadFilter.createdAt.$lte = new Date(report.filters.to);
      }

      const uploads = await Upload.find(uploadFilter)
        .sort({ createdAt: -1 })
        .limit(10000)
        .lean();

      const rows = uploads.map(upload => ({
        reference: upload.reference,
        fileName: upload.originalName,
        status: upload.status,
        fileSizeBytes: upload.sizeBytes,
        rows: upload.rowCount || 0,
        validRecords: upload.validCount || 0,
        invalidRecords: upload.invalidCount || 0,
        duplicates: upload.duplicateCount || 0,
        createdAt: upload.createdAt?.toISOString?.() || '',
        expiresAt: upload.expiresAt?.toISOString?.() || ''
      }));

      if (report.type === 'uploads-csv') {
        await fs.writeFile(
          filePath,
          stringify(rows, { header: true, cast: { string: safeCsv } }),
          { mode: 0o600 }
        );
      } else {
        await pdfToFile(
          filePath,
          'Document Processing Report',
          [
            ['Uploads', rows.length],
            [
              'Processed',
              rows.filter(row =>
                ['review', 'submitted'].includes(row.status)
              ).length
            ],
            ['Failed', rows.filter(row => row.status === 'failed').length],
            ['Total valid records', rows.reduce((sum, row) => sum + row.validRecords, 0)],
            ['Total invalid records', rows.reduce((sum, row) => sum + row.invalidRecords, 0)],
            ['Total duplicates', rows.reduce((sum, row) => sum + row.duplicates, 0)],
            [
              'Date range',
              `${report.filters.from || 'All time'} to ${report.filters.to || 'Now'}`
            ],
            ...rows.slice(0, 200).map(row => [
              row.reference,
              `${row.fileName} · ${row.status} · valid ${row.validRecords} · invalid ${row.invalidRecords}`
            ])
          ],
          `Report ${report.reference}`
        );
      }
    } else if (report.type === 'audit-csv') {
      if (report.requesterRole !== 'admin') {
        throw new Error('Audit report is admin-only');
      }

      const filter = {};

      if (report.filters.from || report.filters.to) {
        filter.createdAt = {};
      }

      if (report.filters.from) {
        filter.createdAt.$gte = new Date(report.filters.from);
      }

      if (report.filters.to) {
        filter.createdAt.$lte = new Date(report.filters.to);
      }

      const logs = await AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .limit(100000)
        .lean();

      const rows = logs.map(log => ({
        time: log.createdAt?.toISOString?.() || '',
        actorRole: log.actorRole,
        actorEmail: log.actorEmail || '',
        action: log.action,
        targetType: log.targetType || '',
        targetId: log.targetId || '',
        result: log.result,
        requestId: log.requestId || ''
      }));

      await fs.writeFile(
        filePath,
        stringify(rows, { header: true, cast: { string: safeCsv } }),
        { mode: 0o600 }
      );
    } else if (report.type === 'operations-pdf') {
      const operationsFilter = { ...campaignFilter };

      if (report.filters.from || report.filters.to) {
        operationsFilter.createdAt = {
          ...(report.filters.from
            ? { $gte: new Date(report.filters.from) }
            : {}),
          ...(report.filters.to
            ? { $lte: new Date(report.filters.to) }
            : {})
        };
      }

      const campaigns = await Campaign.find(operationsFilter).lean();

      const usage = await UsageRecord.aggregate([
        {
          $match: {
            occurredAt: {
              ...(report.filters.from
                ? { $gte: new Date(report.filters.from) }
                : {}),
              ...(report.filters.to
                ? { $lte: new Date(report.filters.to) }
                : {})
            }
          }
        },
        {
          $group: {
            _id: { provider: '$provider', channel: '$channel' },
            units: { $sum: '$units' },
            estimated: { $sum: '$estimatedCost' },
            actual: { $sum: '$actualCost' }
          }
        }
      ]);

      const rows = [
        ['Campaigns', campaigns.length],
        ['Completed campaigns', campaigns.filter(c => c.status === 'completed').length],
        ['Failed campaigns', campaigns.filter(c => ['failed', 'partial_failure'].includes(c.status)).length],
        ...usage.map(item => [
          `${item._id.provider || 'Unknown'} ${item._id.channel || 'usage'}`,
          `${item.units} units; estimated INR ${item.estimated || 0}; actual INR ${item.actual || 0}`
        ])
      ];

      await pdfToFile(filePath, 'Operations Report', rows, `Report ${report.reference}`);
    } else if (['campaigns-csv', 'campaigns-xlsx'].includes(report.type)) {
      const filter = { ...campaignFilter };

      if (report.filters.from || report.filters.to) {
        filter.createdAt = {
          ...(report.filters.from
            ? { $gte: new Date(report.filters.from) }
            : {}),
          ...(report.filters.to
            ? { $lte: new Date(report.filters.to) }
            : {})
        };
      }

      const campaigns = await Campaign.find(filter)
        .sort({ createdAt: -1 })
        .limit(100000)
        .lean();

      const rows = campaigns.map(campaign => ({
        reference: campaign.reference,
        title: campaign.title,
        version: campaign.version,
        status: campaign.status,
        channels: (campaign.channels || []).join(', '),
        recipients: (campaign.recipients || []).length,
        totalJobs: campaign.counters?.total || 0,
        sent: campaign.counters?.sent || 0,
        delivered: campaign.counters?.delivered || 0,
        failed: campaign.counters?.failed || 0,
        estimatedCostINR: Number(campaign.estimatedCost || 0),
        actualCostINR: Number(campaign.actualCost || 0),
        createdAt: campaign.createdAt?.toISOString?.() || '',
        scheduledAt: campaign.scheduleAt?.toISOString?.() || ''
      }));

      if (report.type === 'campaigns-csv') {
        await fs.writeFile(
          filePath,
          stringify(rows, { header: true, cast: { string: safeCsv } }),
          { mode: 0o600 }
        );
      } else {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Campaigns');

        sheet.columns = Object.keys(
          rows[0] || {
            reference: '',
            title: '',
            version: 0,
            status: '',
            channels: '',
            recipients: 0,
            totalJobs: 0,
            sent: 0,
            delivered: 0,
            failed: 0,
            estimatedCostINR: 0,
            actualCostINR: 0,
            createdAt: '',
            scheduledAt: ''
          }
        ).map(key => ({
          header: key,
          key,
          width: Math.min(32, Math.max(14, key.length + 2))
        }));

        sheet.addRows(
          rows.map(row =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value === 'string' ? safeCsv(value) : value
              ])
            )
          )
        );

        sheet.views = [{ state: 'frozen', ySplit: 1 }];

        await workbook.xlsx.writeFile(filePath);
        await fs.chmod(filePath, 0o600);
      }
    } else if (['bills-csv', 'bills-xlsx', 'bills-pdf'].includes(report.type)) {
      if (report.requesterRole !== 'admin') {
        throw new Error('Bill reports are admin-only');
      }

      const filter = {};

      if (report.filters.from || report.filters.to) {
        filter.createdAt = {
          ...(report.filters.from
            ? { $gte: new Date(report.filters.from) }
            : {}),
          ...(report.filters.to
            ? { $lte: new Date(report.filters.to) }
            : {})
        };
      }

      if (report.filters.status && ['draft', 'sent', 'failed'].includes(report.filters.status)) {
        filter.status = report.filters.status;
      }

      const bills = await Bill.find(filter)
        .select('-attachmentPath')
        .sort({ createdAt: -1 })
        .limit(100000)
        .lean();

      const rows = bills.map(bill => ({
        reference: bill.reference,
        billNumber: bill.billNumber || '',
        title: bill.title,
        recipientName: bill.recipientName,
        recipientEmail: bill.recipientEmail,
        organization: bill.organization || '',
        amountINR: Number(bill.amount || 0),
        issueDate: bill.issueDate?.toISOString?.().slice(0, 10) || '',
        dueDate: bill.dueDate?.toISOString?.().slice(0, 10) || '',
        status: bill.status,
        sentAt: bill.sentAt?.toISOString?.() || '',
        createdAt: bill.createdAt?.toISOString?.() || ''
      }));

      if (report.type === 'bills-csv') {
        await fs.writeFile(
          filePath,
          stringify(rows, { header: true, cast: { string: safeCsv } }),
          { mode: 0o600 }
        );
      } else if (report.type === 'bills-xlsx') {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Bills');

        sheet.columns = Object.keys(
          rows[0] || {
            reference: '',
            billNumber: '',
            title: '',
            recipientName: '',
            recipientEmail: '',
            organization: '',
            amountINR: 0,
            issueDate: '',
            dueDate: '',
            status: '',
            sentAt: '',
            createdAt: ''
          }
        ).map(key => ({
          header: key,
          key,
          width: Math.min(32, Math.max(14, key.length + 2))
        }));

        sheet.addRows(
          rows.map(row =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                typeof value === 'string' ? safeCsv(value) : value
              ])
            )
          )
        );

        sheet.views = [{ state: 'frozen', ySplit: 1 }];

        await workbook.xlsx.writeFile(filePath);
        await fs.chmod(filePath, 0o600);
      } else {
        const pdfRows = [
          ['Total bills', rows.length],
          ['Sent', rows.filter(row => row.status === 'sent').length],
          ['Draft', rows.filter(row => row.status === 'draft').length],
          ['Failed', rows.filter(row => row.status === 'failed').length],
          ['Total amount (INR)', rows.reduce((sum, row) => sum + row.amountINR, 0)],
          ...rows.slice(0, 500).map(row => [
            row.reference,
            `${row.title} | ${row.recipientName} | INR ${row.amountINR.toFixed(2)} | ${row.status}`
          ])
        ];

        await pdfToFile(
          filePath,
          'Miscellaneous Bills Report',
          pdfRows,
          `Report ${report.reference}`
        );
      }
    } else {
      throw new Error('Unsupported report type');
    }

    report.storagePath = filePath;
    report.status = 'ready';
    await report.save();

    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = String(error.message || 'Report generation failed').slice(0, 500);
    await report.save();
    throw error;
  }
}