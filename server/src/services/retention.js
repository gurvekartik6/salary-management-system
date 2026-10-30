import fs from 'node:fs/promises';
import { Upload, ExtractedRecord, ReportJob, Campaign, DeliveryJob, BackupRecord, SystemSetting } from '../models/index.js';

export async function runRetentionTasks() {
  const now = new Date();
  const retention = (await SystemSetting.findOne({ key: 'retentionPolicy' }).lean())?.value || {};
  const sensitiveDays = Math.max(1, Number(retention.salaryDataRetentionDays || process.env.SENSITIVE_CAMPAIGN_RETENTION_DAYS || 90));
  const expiredUploads = await Upload.find({ expiresAt: { $lte: now }, status: { $ne: 'expired' } }).select('+storagePath');
  for (const upload of expiredUploads) {
    if (upload.storagePath) await fs.unlink(upload.storagePath).catch(() => {});
    upload.status = 'expired'; await upload.save();
    const related = await Campaign.find({ upload: upload._id, status: { $in: ['draft','awaiting_approval','rejected','approved','scheduled'] } });
    for (const campaign of related) {
      campaign.status = 'cancelled'; campaign.completedAt = now; campaign.recipients = campaign.recipients.map(r => ({ _id:r._id, employee:r.employee, staffId:r.staffId, name:r.name, language:r.language, sourceRecord:r.sourceRecord })); campaign.messageSnapshot = {}; await campaign.save();
      await DeliveryJob.updateMany({ campaign: campaign._id, status: 'queued' }, { $set: { status: 'cancelled' }, $unset: { destination: 1 } });
    }
    await ExtractedRecord.updateMany({ upload: upload._id }, { $unset: { raw: 1, salaryAmount: 1, email: 1, phone: 1 }, $set: { errors: ['Sensitive fields purged according to upload retention policy'], valid: false } });
  }
  const expiredReports = await ReportJob.find({ expiresAt: { $lte: now }, status: { $ne: 'expired' } }).select('+storagePath');
  for (const report of expiredReports) {
    if (report.storagePath) await fs.unlink(report.storagePath).catch(() => {});
    report.status = 'expired'; report.storagePath = undefined; await report.save();
  }
  const expiredBackups = await BackupRecord.find({ expiresAt: { $lte: now }, status: { $in: ['completed','verified','failed'] } }).select('+storageReference');
  for (const backup of expiredBackups) {
    if (backup.storageReference) { await fs.unlink(backup.storageReference).catch(() => {}); await fs.unlink(`${backup.storageReference}.meta`).catch(() => {}); }
    backup.storageReference = undefined; backup.status = 'expired'; await backup.save();
  }
  // Remove salary/contact/message payloads from terminal campaigns after the configured sensitive-data window.
  const cutoff = new Date(now.getTime() - sensitiveDays * 86400000);
  const expiredCampaigns = await Campaign.find({ completedAt: { $lte: cutoff }, status: { $in: ['completed','partial_failure','failed','cancelled'] }, 'messageSnapshot.messages.0': { $exists: true } });
  for (const campaign of expiredCampaigns) {
    campaign.recipients = campaign.recipients.map(r => ({ _id:r._id, employee:r.employee, staffId:r.staffId, name:r.name, language:r.language, sourceRecord:r.sourceRecord }));
    campaign.messageSnapshot = {}; await campaign.save();
    await DeliveryJob.updateMany({ campaign: campaign._id }, { $unset: { destination: 1 } });
  }
  return { expiredUploads: expiredUploads.length, expiredReports: expiredReports.length, expiredBackups: expiredBackups.length, scrubbedCampaigns: expiredCampaigns.length };
}
