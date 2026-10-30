import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const opts = {
  timestamps: true,
  strict: 'throw',
  suppressReservedKeysWarning: true
};

export const Admin = model('Admin', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin'], default: 'admin', index: true },
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
}, opts));

export const Sequence = model('Sequence', new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 }
}, { versionKey: false }));

export const MiscellaneousContact = model('MiscellaneousContact', new Schema({
  name: { type: String, required: true, trim: true },
  organization: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  language: { type: String, enum: ['en', 'mr', 'hi'], default: 'en' },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  active: { type: Boolean, default: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' }
}, opts));

export const Upload = model('Upload', new Schema({
  reference: { type: String, required: true, unique: true, index: true },
  originalName: { type: String, required: true },
  storagePath: { type: String, required: true, select: false },
  sha256: { type: String, required: true, index: true },
  mimeType: String,
  sizeBytes: Number,
  uploadedBy: { type: Schema.Types.ObjectId, required: true, index: true },
  uploaderRole: { type: String, required: true },
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'review', 'submitted', 'rejected', 'failed', 'expired'],
    default: 'uploaded',
    index: true
  },
  sheetCount: Number,
  rowCount: Number,
  validCount: Number,
  invalidCount: Number,
  duplicateCount: Number,
  errors: [String],
  expiresAt: { type: Date, index: true },
  processedAt: Date
}, opts));

export const ExtractedRecord = model('ExtractedRecord', new Schema({
  upload: { type: Schema.Types.ObjectId, ref: 'Upload', required: true, index: true },
  sourceSheet: String,
  sourceRow: Number,
  sourcePage: Number,
  raw: { type: Schema.Types.Mixed, default: {} },
  name: String,
  email: String,
  phone: String,
  language: { type: String, enum: ['en', 'mr', 'hi'], default: 'en' },
  salaryAmount: { type: Schema.Types.Decimal128 },
  salaryPeriod: String,
  valid: { type: Boolean, default: false, index: true },
  duplicate: { type: Boolean, default: false },
  excluded: { type: Boolean, default: false },
  errors: [String],
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  reviewedAt: Date,
  exceptionApprovedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  exceptionApprovedAt: Date,
  exceptionReason: { type: String, maxlength: 500 }
}, opts));

const recipientSchema = new Schema({
  name: String,
  email: String,
  phone: String,
  language: { type: String, enum: ['en', 'mr', 'hi'], default: 'en' },
  salaryAmount: Schema.Types.Decimal128,
  salaryPeriod: String,
  salaryDetails: { type: Schema.Types.Mixed, default: {} },
  sourceRecord: { type: Schema.Types.ObjectId, ref: 'ExtractedRecord' },
  sourceRow: Number,
  sourceSheet: String,
  exceptionApprovedBy: { type: Schema.Types.ObjectId, ref: 'Admin' }
}, { _id: true });

export const Campaign = model('Campaign', new Schema({
  reference: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, index: true, sparse: true },
  title: { type: String, required: true, maxlength: 160 },
  owner: { type: Schema.Types.ObjectId, required: true, index: true },
  ownerRole: { type: String, required: true },
  upload: { type: Schema.Types.ObjectId, ref: 'Upload', required: true },
  version: { type: Number, default: 1 },
  parentCampaign: { type: Schema.Types.ObjectId, ref: 'Campaign' },
  status: {
    type: String,
    enum: ['draft', 'awaiting_approval', 'rejected', 'approved', 'scheduled', 'sending', 'paused', 'cancelling', 'cancelled', 'completed', 'partial_failure', 'failed'],
    default: 'draft',
    index: true
  },
  cancellationRequest: {
    requestedBy: Schema.Types.ObjectId,
    requestedAt: Date,
    reason: { type: String, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'] }
  },
  channels: { type: [String], enum: ['email', 'sms', 'whatsapp'], default: ['email', 'sms', 'whatsapp'] },
  recipients: [recipientSchema],
  templateVersions: { type: Schema.Types.Mixed, default: {} },
  messageSnapshot: { type: Schema.Types.Mixed, default: {} },
  reviewAcknowledgement: {
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    reviewedAt: Date,
    snapshotHash: String
  },
  approval: {
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    approvedAt: Date,
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    rejectionReason: String,
    snapshotHash: String
  },
  scheduleAt: Date,
  dispatchEnqueuedAt: Date,
  dispatchPreparedAt: Date,
  startedAt: Date,
  completedAt: Date,
  counters: {
    total: { type: Number, default: 0 },
    queued: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    unknown: { type: Number, default: 0 }
  },
  estimatedCost: { type: Number, default: 0 },
  actualCost: { type: Number, default: 0 },
  createdByVersion: Number,
  notes: String
}, opts));
Campaign.schema.index(
  { owner: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const DeliveryJob = model('DeliveryJob', new Schema({
  idempotencyKey: { type: String, required: true, unique: true },
  campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  campaignVersion: { type: Number, required: true },
  recipientIndex: Number,
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  destination: String,
  status: {
    type: String,
    enum: ['queued', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'unknown', 'cancelled'],
    default: 'queued',
    index: true
  },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  providerMessageId: String,
  lastErrorCode: String,
  lastError: String,
  acceptedAt: Date,
  deliveredAt: Date,
  cost: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' }
}, opts));

export const DispatchOutbox = model('DispatchOutbox', new Schema({
  campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, unique: true },
  version: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'enqueued', 'failed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastError: String,
  enqueuedAt: Date
}, opts));

export const DeliveryAttempt = model('DeliveryAttempt', new Schema({
  job: { type: Schema.Types.ObjectId, ref: 'DeliveryJob', required: true, index: true },
  provider: String,
  attemptNumber: Number,
  status: String,
  providerMessageId: String,
  errorCode: String,
  errorMessage: String,
  startedAt: Date,
  finishedAt: Date,
  cost: Number,
  currency: { type: String, default: 'INR' }
}, opts));

export const Template = model('Template', new Schema({
  key: { type: String, required: true, index: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  language: { type: String, enum: ['en', 'mr', 'hi'], required: true },
  version: { type: Number, required: true },
  subject: String,
  body: { type: String, required: true },
  whatsappTemplateName: String,
  whatsappLanguageCode: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
  editedBy: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
  publishedAt: Date
}, opts));

Template.schema.index({ key: 1, channel: 1, language: 1, version: 1 }, { unique: true });

export const SiteContent = model('SiteContent', new Schema({
  key: { type: String, required: true, index: true },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
  content: { type: Schema.Types.Mixed, default: {} },
  editedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  publishedAt: Date
}, opts));

SiteContent.schema.index({ key: 1, version: 1 }, { unique: true });

export const SystemSetting = model('SystemSetting', new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed, default: {} },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' }
}, opts));

export const AuditLog = model('AuditLog', new Schema({
  actorId: String,
  actorRole: { type: String, required: true },
  actorEmail: String,
  action: { type: String, required: true, index: true },
  targetType: String,
  targetId: String,
  result: { type: String, enum: ['success', 'failure', 'denied'], default: 'success' },
  requestId: String,
  ipHash: String,
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, expires: 31536000 }
}, { versionKey: false }));

export const Bill = model('Bill', new Schema({
  reference: { type: String, required: true, unique: true, index: true },
  billNumber: { type: String, trim: true, default: '' },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  recipientName: { type: String, required: true, trim: true, maxlength: 160 },
  recipientEmail: { type: String, required: true, trim: true, lowercase: true },
  organization: { type: String, trim: true, maxlength: 200, default: '' },
  amount: { type: Schema.Types.Decimal128, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  issueDate: Date,
  dueDate: Date,
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  attachmentPath: { type: String, select: false },
  attachmentName: String,
  attachmentMimeType: String,
  attachmentSizeBytes: Number,
  status: { type: String, enum: ['draft', 'sent', 'failed'], default: 'draft', index: true },
  sentAt: Date,
  lastError: { type: String, maxlength: 500, default: '' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' }
}, opts));

export const ReportJob = model('ReportJob', new Schema({
  reference: { type: String, required: true, unique: true },
  requestedBy: { type: Schema.Types.ObjectId, required: true, index: true },
  requesterRole: { type: String, required: true },
  type: {
    type: String,
    enum: ['campaign-pdf', 'deliveries-xlsx', 'deliveries-csv', 'uploads-pdf', 'uploads-csv', 'audit-csv', 'operations-pdf', 'bills-csv', 'bills-xlsx', 'bills-pdf', 'campaigns-csv', 'campaigns-xlsx'],
    required: true
  },
  filters: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['queued', 'processing', 'ready', 'failed', 'expired'], default: 'queued', index: true },
  storagePath: { type: String, select: false },
  expiresAt: { type: Date, index: true },
  error: String,
  downloadedAt: Date,
  downloadCount: { type: Number, default: 0 }
}, opts));

export const ReportDownload = model('ReportDownload', new Schema({
  report: { type: Schema.Types.ObjectId, ref: 'ReportJob', required: true, index: true },
  actorId: String,
  actorRole: String,
  downloadedAt: { type: Date, default: Date.now },
  result: { type: String, enum: ['success', 'denied', 'failure'], default: 'success' },
  requestId: String
}, { timestamps: true }));

export const ProviderEvent = model('ProviderEvent', new Schema({
  provider: { type: String, required: true },
  eventId: { type: String, required: true },
  providerMessageId: String,
  status: String,
  receivedAt: { type: Date, default: Date.now, expires: 31536000 }
}, { versionKey: false }));

ProviderEvent.schema.index({ provider: 1, eventId: 1 }, { unique: true });

export const UsageRecord = model('UsageRecord', new Schema({
  campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', index: true },
  deliveryJob: { type: Schema.Types.ObjectId, ref: 'DeliveryJob' },
  provider: String,
  channel: String,
  units: { type: Number, default: 1 },
  currency: { type: String, default: 'INR' },
  estimatedCost: Number,
  actualCost: Number,
  reconciliationStatus: { type: String, enum: ['estimated', 'reconciled', 'disputed'], default: 'estimated' },
  occurredAt: { type: Date, default: Date.now }
}, opts));

UsageRecord.schema.index({ deliveryJob: 1 }, { unique: true, sparse: true });

export const BackupRecord = model('BackupRecord', new Schema({
  reference: { type: String, required: true, unique: true },
  provider: String,
  storageReference: { type: String, select: false },
  remoteReference: String,
  checksum: String,
  sizeBytes: Number,
  status: { type: String, enum: ['requested', 'running', 'completed', 'verified', 'failed', 'restoring', 'expired'], default: 'requested' },
  startedAt: Date,
  completedAt: Date,
  verifiedAt: Date,
  restoreTestedAt: Date,
  expiresAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  error: String
}, opts));