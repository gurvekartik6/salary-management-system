import {
  Campaign,
  DeliveryAttempt,
  DeliveryJob,
  ProviderEvent
} from '../models/index.js';

const providerStatuses = {
  delivered: 'delivered',
  read: 'delivered',
  undelivered: 'failed',
  failed: 'failed',
  bounced: 'bounced',
  sent: 'sent',
  accepted: 'sent'
};

export function mapProviderStatus(status) {
  return providerStatuses[String(status || '').toLowerCase()];
}

export function canApplyProviderStatus(currentStatus, nextStatus) {
  if (!nextStatus) return false;
  if (['delivered', 'bounced', 'cancelled'].includes(currentStatus)) {
    return false;
  }
  if (currentStatus === 'failed' && nextStatus === 'sent') {
    return false;
  }
  return !(currentStatus === 'delivered' && nextStatus !== 'delivered');
}

const terminalCampaignStatuses = [
  'cancelled',
  'cancelling',
  'rejected',
  'paused',
  'failed',
  'completed',
  'partial_failure'
];

export async function recalculateCampaign(campaignId) {
  const jobs = await DeliveryJob.aggregate([
    { $match: { campaign: campaignId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  const counts = Object.fromEntries(
    jobs.map(item => [item._id, item.count])
  );
  const total = Object.values(counts).reduce(
    (sum, count) => sum + count,
    0
  );

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) return null;

  campaign.counters = {
    total,
    queued: (counts.queued || 0) + (counts.sending || 0),
    sent: counts.sent || 0,
    delivered: counts.delivered || 0,
    failed: counts.failed || 0,
    bounced: counts.bounced || 0,
    unknown: counts.unknown || 0
  };

  if (!terminalCampaignStatuses.includes(campaign.status)) {
    const noActiveDeliveries = !counts.queued && !counts.sending;

    if (noActiveDeliveries && total > 0 && campaign.dispatchPreparedAt) {
      campaign.status =
        counts.failed || counts.bounced || counts.unknown
          ? 'partial_failure'
          : 'completed';
      campaign.completedAt = new Date();
    }
  }

  await campaign.save();
  return campaign;
}

export async function updateDeliveryFromProvider({
  providerMessageId,
  status,
  errorCode = '',
  provider = 'unknown',
  eventId = ''
}) {
  if (!providerMessageId) return null;

  const job = await DeliveryJob.findOne({ providerMessageId });
  if (!job) return null;

  const mapped = mapProviderStatus(status);
  if (!mapped) return job;

  if (!canApplyProviderStatus(job.status, mapped)) return job;

  let newEvent = true;
  if (eventId) {
    try {
      await ProviderEvent.create({
        provider,
        eventId: String(eventId).slice(0, 300),
        providerMessageId,
        status: mapped
      });
    } catch (error) {
      if (error.code === 11000) {
        newEvent = false;
      } else {
        throw error;
      }
    }
  }

  if (!newEvent) return job;

  job.status = mapped;
  if (mapped === 'delivered') job.deliveredAt = new Date();
  if (errorCode) job.lastErrorCode = String(errorCode).slice(0, 100);
  await job.save();

  await DeliveryAttempt.create({
    job: job._id,
    provider,
    attemptNumber: job.attempts,
    status: mapped,
    providerMessageId,
    errorCode,
    finishedAt: new Date()
  });

  await recalculateCampaign(job.campaign);
  return job;
}
