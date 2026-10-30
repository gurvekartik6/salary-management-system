import { SystemSetting } from '../models/index.js';
export async function bootstrapSettings() {
  const defaults = {
    uploadPolicy: { maxUploadMB: Number(process.env.MAX_UPLOAD_MB || 20), maxRecipientsPerCampaign: 1000, maxRowsPerUpload: 1000 },
    notificationPolicy: { enabledChannels: ['email','sms','whatsapp'], requireAdminApproval: true },
    providerPricing: { emailCostPerMessage: Number(process.env.EMAIL_COST_PER_MESSAGE || 0), smsCostPerSegment: Number(process.env.SMS_COST_PER_SEGMENT || 0), whatsappCostPerMessage: Number(process.env.WHATSAPP_COST_PER_MESSAGE || 0) },
    costLimits: { maxCampaignCostINR: 0, monthlyBudgetINR: 0 },
    retentionPolicy: { uploadRetentionDays: 90, salaryDataRetentionDays: 90, backupRetentionDays: 35 },
    reportPolicy: { retentionDays: 30 },
    localePolicy: { defaultLanguage: 'en', supportedLanguages: ['en','mr','hi'] }
  };
  for (const [key, value] of Object.entries(defaults)) await SystemSetting.updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
}
