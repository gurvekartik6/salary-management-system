
import { Worker } from 'bullmq';
import { getNotificationQueue } from '../services/queue.js';
import { createHash } from 'node:crypto';
import {
  Campaign,
  DeliveryJob,
  DeliveryAttempt,
  UsageRecord,
  BackupRecord,
  SystemSetting,
  DispatchOutbox
} from '../models/index.js';
import { processUpload } from '../services/documentProcessor.js';
import { generateReport } from '../services/reportGenerator.js';
import {
  createEncryptedBackup,
  verifyEncryptedBackup
} from '../services/backupService.js';
import {
  sendEmail,
  sendSms,
  sendWhatsApp
} from '../services/notifications.js';
import { audit } from '../utils/audit.js';
import { recalculateCampaign } from '../services/deliveryState.js';

function redisConnection() {
  const url = new URL(
    process.env.REDIS_URL || 'redis://127.0.0.1:6379'
  );

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username
      ? decodeURIComponent(url.username)
      : undefined,
    password: url.password
      ? decodeURIComponent(url.password)
      : undefined,
    maxRetriesPerRequest: null,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {})
  };
}

function campaignSnapshotHash(campaign) {
  const snapshot = {
    reference: campaign.reference,
    version: campaign.version,
    recipients: (campaign.recipients || []).map(recipient => ({
      email: recipient.email,
      phone: recipient.phone,
      salaryAmount: recipient.salaryAmount?.toString?.(),
      salaryPeriod: recipient.salaryPeriod,
      language: recipient.language,
      sourceRow: recipient.sourceRow,
      sourceSheet: recipient.sourceSheet
    })),
    channels: campaign.channels,
    templateVersions: campaign.templateVersions,
    messageSnapshot: campaign.messageSnapshot
  };

  return createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
}

async function dispatchCampaign(job, queue) {
  const campaign = await Campaign.findById(
    job.data.campaignId
  );

  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.version !== job.data.version) return;

  if (
    !['approved', 'scheduled', 'sending'].includes(
      campaign.status
    )
  ) {
    return;
  }

  if (
    campaign.status === 'sending' &&
    campaign.dispatchPreparedAt
  ) {
    return;
  }

  if (
    campaign.scheduleAt &&
    campaign.scheduleAt > new Date()
  ) {
    await queue.add(
      'dispatch-campaign',
      job.data,
      {
        jobId:
          `dispatch-${campaign._id}-v${campaign.version}-rescheduled`,
        delay:
          campaign.scheduleAt.getTime() - Date.now(),
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000
        },
        removeOnComplete: true
      }
    );

    return;
  }

  if (
    !campaign.approval?.snapshotHash ||
    campaignSnapshotHash(campaign) !==
      campaign.approval.snapshotHash
  ) {
    campaign.status = 'failed';
    await campaign.save();

    throw new Error(
      'Approved campaign snapshot integrity check failed'
    );
  }

  campaign.status = 'sending';
  campaign.startedAt =
    campaign.startedAt || new Date();

  await campaign.save();

  const deliveryDocs = [];

  for (
    let recipientIndex = 0;
    recipientIndex < campaign.recipients.length;
    recipientIndex += 1
  ) {
    const recipient =
      campaign.recipients[recipientIndex];

    for (const channel of campaign.channels) {
      const destination =
        channel === 'email'
          ? recipient.email
          : recipient.phone;

      const idempotencyKey =
        `${campaign._id}:v${campaign.version}:` +
        `${String(recipient.email || '').toLowerCase()}:${channel}`;

      const delivery =
        await DeliveryJob.findOneAndUpdate(
          { idempotencyKey },
          {
            $setOnInsert: {
              idempotencyKey,
              campaign: campaign._id,
              campaignVersion: campaign.version,
              recipientIndex,
              channel,
              destination,
              status: 'queued',
              nextAttemptAt: new Date()
            }
          },
          {
            upsert: true,
            new: true
          }
        );

      if (delivery.status === 'queued') {
        deliveryDocs.push(delivery);
      }
    }
  }

  for (const delivery of deliveryDocs) {
    await queue.add(
      'send-delivery',
      {
        deliveryJobId: String(delivery._id)
      },
      {
        jobId: `delivery-${delivery._id}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 30000
        },
        removeOnComplete: {
          age: 86400,
          count: 5000
        },
        removeOnFail: {
          age: 604800,
          count: 10000
        }
      }
    );
  }

  campaign.dispatchPreparedAt = new Date();
  await campaign.save();

  await recalculateCampaign(campaign._id);

  await audit(
    null,
    'campaign.dispatch.started',
    'campaign',
    campaign._id,
    'success',
    {
      reference: campaign.reference,
      version: campaign.version
    }
  );
}

async function sendDelivery(job) {
  const delivery = await DeliveryJob.findById(
    job.data.deliveryJobId
  );

  if (
    !delivery ||
    [
      'sent',
      'delivered',
      'bounced',
      'cancelled',
      'failed',
      'unknown'
    ].includes(delivery.status)
  ) {
    return;
  }

  if (delivery.status === 'sending') {
    delivery.status = 'unknown';
    delivery.lastErrorCode = 'INTERRUPTED_ATTEMPT';
    delivery.lastError =
      'Worker restarted during a provider attempt. ' +
      'Reconcile provider status before retrying.';

    await delivery.save();
    await recalculateCampaign(delivery.campaign);
    return;
  }

  const campaign = await Campaign.findById(
    delivery.campaign
  );

  if (
    !campaign ||
    campaign.version !== delivery.campaignVersion
  ) {
    delivery.status = 'cancelled';
    await delivery.save();
    return;
  }

  if (campaign.status === 'paused') return;

  if (
    ['cancelling', 'cancelled'].includes(
      campaign.status
    )
  ) {
    delivery.status = 'cancelled';

    await delivery.save();
    await recalculateCampaign(campaign._id);
    return;
  }

  if (campaign.status !== 'sending') {
    delivery.status = 'cancelled';
    delivery.lastErrorCode = 'CAMPAIGN_NOT_SENDING';
    delivery.lastError =
      'Campaign is not in a dispatchable state';

    await delivery.save();
    await recalculateCampaign(campaign._id);
    return;
  }

  const recipient =
    campaign.recipients[delivery.recipientIndex];

  const message = (
    campaign.messageSnapshot?.messages || []
  ).find(item =>
    item.recipientIndex === delivery.recipientIndex &&
    item.channel === delivery.channel
  );

  if (!recipient || !message) {
    throw new Error(
      'Approved recipient/message snapshot is incomplete'
    );
  }

  const attemptNumber = delivery.attempts + 1;

  delivery.status = 'sending';
  delivery.attempts = attemptNumber;

  await delivery.save();

  const attempt = await DeliveryAttempt.create({
    job: delivery._id,
    provider: delivery.channel,
    attemptNumber,
    status: 'sending',
    startedAt: new Date()
  });

  let result;

  try {
    if (delivery.channel === 'email') {
      result = await sendEmail({
        to: delivery.destination,
        subject: message.subject,
        body: message.body
      });
    } else if (delivery.channel === 'sms') {
      result = await sendSms({
        to: delivery.destination,
        body: message.body
      });
    } else if (delivery.channel === 'whatsapp') {
      result = await sendWhatsApp({
        to: delivery.destination,
        body: message.body,
        templateName: message.whatsappTemplateName,
        language: message.language,
        languageCode: message.whatsappLanguageCode,
        variables: message.variables
      });
    } else {
      throw Object.assign(
        new Error(
          `Unsupported delivery channel: ${delivery.channel}`
        ),
        { code: 'UNSUPPORTED_CHANNEL' }
      );
    }

    if (result?.accepted === false) {
      throw Object.assign(
        new Error('Provider did not accept the message'),
        { code: 'PROVIDER_NOT_ACCEPTED' }
      );
    }
  } catch (error) {
    const ambiguous = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNABORTED',
      'ESOCKET',
      'AbortError',
      'TimeoutError'
    ].includes(error.code) ||
      ['AbortError', 'TimeoutError'].includes(
        error.name
      ) ||
      Number(error.status || 0) >= 500;

    const retryable =
      !ambiguous &&
      (
        Number(error.status || 0) === 429 ||
        [
          'ECONNREFUSED',
          'EAI_AGAIN',
          'ENOTFOUND'
        ].includes(error.code) ||
        (
          Number(error.responseCode || 0) >= 400 &&
          Number(error.responseCode || 0) < 500 &&
          Number(error.responseCode || 0) !== 550
        )
      );

    delivery.status = ambiguous
      ? 'unknown'
      : retryable
        ? 'queued'
        : 'failed';

    delivery.lastError = String(
      error.message || 'Provider send failed'
    ).slice(0, 500);

    delivery.lastErrorCode = String(
      error.code ||
      error.status ||
      error.responseCode ||
      'PROVIDER_ERROR'
    );

    delivery.nextAttemptAt = new Date(
      Date.now() +
      Math.min(
        3600000,
        30000 * (2 ** Math.max(0, attemptNumber - 1))
      )
    );

    await delivery.save();

    attempt.status = ambiguous ? 'unknown' : 'failed';
    attempt.errorCode = delivery.lastErrorCode;
    attempt.errorMessage = delivery.lastError;
    attempt.finishedAt = new Date();

    await attempt.save();
    await recalculateCampaign(campaign._id);

    if (retryable) throw error;
    return;
  }

  // Once the provider accepts a message, do not automatically resend it
  // merely because a later database operation fails.
  delivery.status = 'sent';
  delivery.providerMessageId = result.providerMessageId;
  delivery.acceptedAt = new Date();
  delivery.cost = Number(result.cost || 0);
  delivery.lastError = undefined;
  delivery.lastErrorCode = undefined;

  await delivery.save();

  attempt.provider = result.provider;
  attempt.providerMessageId = result.providerMessageId;
  attempt.status = 'sent';
  attempt.cost = delivery.cost;
  attempt.finishedAt = new Date();

  await attempt.save();

  await UsageRecord.updateOne(
    { deliveryJob: delivery._id },
    {
      $setOnInsert: {
        campaign: campaign._id,
        deliveryJob: delivery._id,
        provider: result.provider,
        channel: delivery.channel,
        units: Number(result.units || 1),
        currency: 'INR',
        estimatedCost: delivery.cost,
        actualCost: 0,
        occurredAt: new Date()
      }
    },
    { upsert: true }
  );

  await recalculateCampaign(campaign._id);
}

export async function startWorkers() {
  const connection = redisConnection();

  // Reuse the queue initialized by services/queue.js.
  const notificationsQueue = getNotificationQueue();

  const processing = new Worker(
    'processing',
    async job => {
      if (job.name === 'process-upload') {
        return processUpload(job.data.uploadId);
      }

      throw new Error(
        `Unknown processing job ${job.name}`
      );
    },
    {
      connection,
      concurrency: 2
    }
  );

  const notifications = new Worker(
    'notifications',
    async job => {
      if (job.name === 'dispatch-campaign') {
        return dispatchCampaign(
          job,
          notificationsQueue
        );
      }

      if (job.name === 'send-delivery') {
        return sendDelivery(job);
      }

      throw new Error(
        `Unknown notification job ${job.name}`
      );
    },
    {
      connection,
      concurrency: 5
    }
  );

  const reports = new Worker(
    'reports',
    async job => {
      if (job.name === 'generate-report') {
        return generateReport(job.data.reportId);
      }

      throw new Error(
        `Unknown report job ${job.name}`
      );
    },
    {
      connection,
      concurrency: 2
    }
  );

  const backups = new Worker(
    'backups',
    async job => {
      if (job.name === 'create-backup') {
        return createEncryptedBackup(
          job.data.backupId
        );
      }

      if (job.name === 'scheduled-daily-backup') {
        const backupsDisabled = [
          'false',
          '0',
          'no',
          'off'
        ].includes(
          String(
            process.env.BACKUP_DAILY_ENABLED ?? 'false'
          ).trim().toLowerCase()
        );

        if (backupsDisabled) {
          return {
            skipped: true,
            reason:
              'Daily backups disabled by configuration'
          };
        }

        if (!process.env.BACKUP_ENCRYPTION_PASSPHRASE) {
          throw new Error(
            'Daily backup blocked: ' +
            'BACKUP_ENCRYPTION_PASSPHRASE is not configured'
          );
        }

        if (
          process.env.NODE_ENV === 'production' &&
          !process.env.BACKUP_RCLONE_REMOTE
        ) {
          throw new Error(
            'Daily backup blocked: ' +
            'off-host BACKUP_RCLONE_REMOTE is not configured'
          );
        }

        const retention = (
          await SystemSetting.findOne({
            key: 'retentionPolicy'
          }).lean()
        )?.value || {};

        const record = await BackupRecord.create({
          reference:
            `SGGS-BKP-${Date.now()}-` +
            `${createHash(String(Date.now())).
              digest('hex').slice(0, 6).toUpperCase()}`,
          provider: process.env.BACKUP_RCLONE_REMOTE
            ? 'encrypted-local-and-offhost-rclone'
            : 'encrypted-local',
          status: 'requested',
          expiresAt: new Date(
            Date.now() +
            Number(
              retention.backupRetentionDays ||
              process.env.BACKUP_RETENTION_DAYS ||
              35
            ) * 86400000
          )
        });

        await audit(
          null,
          'backup.daily.started',
          'backup',
          record._id,
          'success',
          { reference: record.reference }
        );

        try {
          const result = await createEncryptedBackup(
            record._id
          );

          await audit(
            null,
            'backup.daily.completed',
            'backup',
            record._id,
            'success',
            {
              reference: record.reference,
              remoteReference:
                result.remoteReference || ''
            }
          );

          return {
            backupId: String(result._id),
            reference: result.reference
          };
        } catch (error) {
          await audit(
            null,
            'backup.daily.failed',
            'backup',
            record._id,
            'failure',
            {
              reference: record.reference,
              error: String(
                error.message || 'backup failed'
              ).slice(0, 200)
            }
          );

          throw error;
        }
      }

      if (job.name === 'verify-backup') {
        return verifyEncryptedBackup(
          job.data.backupId
        );
      }

      throw new Error(
        `Unknown backup job ${job.name}`
      );
    },
    {
      connection,
      concurrency: 1
    }
  );

  const workers = [
    processing,
    notifications,
    reports,
    backups
  ];

  for (const worker of workers) {
    worker.on('failed', async (job, error) => {
      console.error(
        `Worker ${worker.name} job ${job?.id} failed:`,
        error.message
      );

      if (
        worker.name === 'notifications' &&
        job?.name === 'send-delivery' &&
        job.attemptsMade >= Number(job.opts.attempts || 1)
      ) {
        try {
          const delivery = await DeliveryJob.findById(
            job.data.deliveryJobId
          );

          if (
            delivery &&
            delivery.status === 'queued'
          ) {
            delivery.status = 'failed';
            delivery.lastError = String(
              error.message || 'Retry limit reached'
            ).slice(0, 500);
            delivery.lastErrorCode =
              'RETRY_LIMIT_REACHED';

            await delivery.save();
            await recalculateCampaign(
              delivery.campaign
            );
          }
        } catch (failure) {
          console.error(
            'Could not finalize exhausted delivery job:',
            failure.message
          );
        }
      }
    });

    worker.on('error', error => {
      console.error(
        `Worker ${worker.name} error:`,
        error.message
      );
    });
  }

  return {
    processing,
    notifications,
    reports,
    backups,

    close: async () => {
      await Promise.allSettled(
        workers.map(worker => worker.close())
      );
    }
  };
}

export async function reconcileQueueTasks() {
  const queue = getNotificationQueue();

  const outboxes = await DispatchOutbox.find({
    status: { $in: ['pending', 'failed'] },
    nextAttemptAt: { $lte: new Date() }
  }).limit(1000).lean();
  for (const outbox of outboxes) {
    const campaign = await Campaign.findOne({
      _id: outbox.campaign,
      version: outbox.version,
      status: { $in: ['approved', 'scheduled'] }
    }).select('_id version scheduleAt').lean();
    if (!campaign) {
      await DispatchOutbox.updateOne({ _id: outbox._id }, { $set: { status: 'enqueued' } });
      continue;
    }
    try {
      const delay = campaign.scheduleAt && campaign.scheduleAt > new Date()
        ? campaign.scheduleAt.getTime() - Date.now()
        : 0;
      await queue.add('dispatch-campaign', { campaignId: String(campaign._id), version: campaign.version }, {
        jobId: `dispatch-${campaign._id}-v${campaign.version}`,
        delay,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true
      });
      await DispatchOutbox.updateOne({ _id: outbox._id }, { $set: { status: 'enqueued', enqueuedAt: new Date(), lastError: undefined }, $inc: { attempts: 1 } });
      await Campaign.updateOne({ _id: campaign._id, version: campaign.version }, { $set: { dispatchEnqueuedAt: new Date() } });
    } catch (error) {
      await DispatchOutbox.updateOne({ _id: outbox._id }, { $set: { status: 'failed', lastError: String(error.message).slice(0, 500), nextAttemptAt: new Date(Date.now() + 60000) }, $inc: { attempts: 1 } });
    }
  }

  // Do not automatically resend messages whose provider status is uncertain.
  const staleBefore = new Date(
    Date.now() - 15 * 60 * 1000
  );

  const staleSending = await DeliveryJob.find({
    status: 'sending',
    updatedAt: { $lt: staleBefore }
  })
    .select('_id campaign')
    .limit(1000)
    .lean();

  const affectedCampaigns = new Set();

  for (const item of staleSending) {
    const updated = await DeliveryJob.findOneAndUpdate(
      {
        _id: item._id,
        status: 'sending',
        updatedAt: { $lt: staleBefore }
      },
      {
        $set: {
          status: 'unknown',
          lastErrorCode: 'INTERRUPTED_ATTEMPT',
          lastError:
            'Worker stopped during delivery. ' +
            'Verify provider status before any retry.'
        }
      },
      { new: true }
    )
      .select('_id campaign')
      .lean();

    if (updated) {
      affectedCampaigns.add(
        String(updated.campaign)
      );
    }
  }

  for (const campaignId of affectedCampaigns) {
    await recalculateCampaign(campaignId);
  }

  const campaigns = await Campaign.find({
    status: { $in: ['approved', 'scheduled'] }
  })
    .select('_id version status scheduleAt')
    .limit(1000)
    .lean();

  for (const campaign of campaigns) {
    const jobId =
      `dispatch-${campaign._id}-v${campaign.version}`;

    const existing = await queue.getJob(jobId);
    const existingState = existing
      ? await existing.getState()
      : 'missing';

    if (!existing || existingState === 'failed') {
      const delay =
        campaign.scheduleAt &&
        campaign.scheduleAt > new Date()
          ? campaign.scheduleAt.getTime() - Date.now()
          : 0;

      const recoveryId = existing
        ? `dispatch-recovery-${campaign._id}-v${campaign.version}-${Date.now()}`
        : jobId;

      await queue.add(
        'dispatch-campaign',
        {
          campaignId: String(campaign._id),
          version: campaign.version
        },
        {
          jobId: recoveryId,
          delay,
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 5000
          },
          removeOnComplete: true
        }
      );
    }
  }

  const sentWithoutUsage = await DeliveryJob.find({
    status: { $in: ['sent', 'delivered'] },
    providerMessageId: {
      $exists: true,
      $ne: ''
    }
  })
    .select(
      '_id campaign channel cost providerMessageId'
    )
    .limit(1000)
    .lean();

  for (const delivery of sentWithoutUsage) {
    if (
      await UsageRecord.exists({
        deliveryJob: delivery._id
      })
    ) {
      continue;
    }

    const attempt = await DeliveryAttempt.findOne({
      job: delivery._id,
      providerMessageId:
        delivery.providerMessageId
    })
      .sort({ attemptNumber: -1 })
      .lean();

    if (attempt) {
      await UsageRecord.updateOne(
        { deliveryJob: delivery._id },
        {
          $setOnInsert: {
            campaign: delivery.campaign,
            deliveryJob: delivery._id,
            provider: attempt.provider,
            channel: delivery.channel,
            units: 1,
            currency: 'INR',
            estimatedCost: Number(
              delivery.cost || 0
            ),
            actualCost: 0,
            occurredAt:
              attempt.finishedAt || new Date()
          }
        },
        { upsert: true }
      );
    }
  }

  const incompleteDispatches = await Campaign.find({
    status: 'sending',
    dispatchPreparedAt: { $exists: false }
  })
    .select('_id version')
    .limit(1000)
    .lean();

  for (const campaign of incompleteDispatches) {
    const jobId =
      `dispatch-recovery-${campaign._id}-v${campaign.version}`;

    if (!(await queue.getJob(jobId))) {
      await queue.add(
        'dispatch-campaign',
        {
          campaignId: String(campaign._id),
          version: campaign.version
        },
        {
          jobId,
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 5000
          }
        }
      );
    }
  }

  const activeCampaigns = await Campaign.find({
    status: 'sending',
    dispatchPreparedAt: { $exists: true }
  })
    .select('_id')
    .limit(1000)
    .lean();

  for (const campaign of activeCampaigns) {
    const queuedDeliveries = await DeliveryJob.find({
      campaign: campaign._id,
      status: 'queued'
    })
      .select('_id')
      .limit(5000)
      .lean();

    for (const delivery of queuedDeliveries) {
      const jobId = `delivery-${delivery._id}`;

      if (!(await queue.getJob(jobId))) {
        await queue.add(
          'send-delivery',
          {
            deliveryJobId: String(delivery._id)
          },
          {
            jobId,
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 30000
            },
            removeOnComplete: {
              age: 86400,
              count: 5000
            },
            removeOnFail: {
              age: 604800,
              count: 10000
            }
          }
        );
      }
    }
  }
}
