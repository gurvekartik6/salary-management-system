
import { Queue } from 'bullmq';
import { createClient } from 'redis';

function isRedisEnabled() {
  return !['false', '0', 'no', 'off'].includes(
    String(process.env.REDIS_ENABLED ?? 'true')
      .trim()
      .toLowerCase()
  );
}

let redisClient;
let notificationQueue;
let reportQueue;
let processingQueue;
let backupQueue;

function getRedisConnectionOptions(redisUrl) {
  const url = new URL(redisUrl);

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

export async function initializeQueues() {
  if (!isRedisEnabled()) {
    console.warn(
      'Redis is disabled. Queue initialization skipped.'
    );

    return {
      notificationQueue: null,
      reportQueue: null,
      processingQueue: null,
      backupQueue: null
    };
  }

  if (
    notificationQueue &&
    processingQueue &&
    reportQueue &&
    backupQueue
  ) {
    return {
      notificationQueue,
      reportQueue,
      processingQueue,
      backupQueue
    };
  }

  const redisUrl =
    process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  let parsedUrl;

  try {
    parsedUrl = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL is not a valid URL.');
  }

  if (!['redis:', 'rediss:'].includes(parsedUrl.protocol)) {
    throw new Error(
      'REDIS_URL must start with redis:// or rediss://'
    );
  }

  const connection = getRedisConnectionOptions(redisUrl);

  redisClient = createClient({
    url: redisUrl
  });

  redisClient.on('error', error => {
    console.error('Redis client error:', error.message);
  });

  try {
    await redisClient.connect();

    const pingResult = await redisClient.ping();

    if (pingResult !== 'PONG') {
      throw new Error('Redis health check did not return PONG.');
    }

    const commonJobOptions = {
      removeOnComplete: {
        age: 86400,
        count: 5000
      },
      removeOnFail: {
        age: 604800,
        count: 10000
      }
    };

    notificationQueue = new Queue('notifications', {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 30000
        },
        ...commonJobOptions
      }
    });

    processingQueue = new Queue('processing', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        },
        ...commonJobOptions
      }
    });

    reportQueue = new Queue('reports', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        },
        ...commonJobOptions
      }
    });

    backupQueue = new Queue('backups', {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 10000
        },
        ...commonJobOptions
      }
    });

    const backupsDisabled = [
      'false',
      '0',
      'no',
      'off'
    ].includes(
      String(process.env.BACKUP_DAILY_ENABLED ?? 'false')
        .trim()
        .toLowerCase()
    );

    if (!backupsDisabled) {
      await backupQueue.add(
        'scheduled-daily-backup',
        {},
        {
          repeat: {
            pattern:
              process.env.BACKUP_CRON || '0 2 * * *',
            tz:
              process.env.BACKUP_TIMEZONE ||
              'Asia/Kolkata'
          },
          jobId: 'sggs-daily-backup-schedule',
          removeOnComplete: {
            age: 86400
          },
          removeOnFail: {
            age: 604800
          }
        }
      );

      console.info(
        'Daily backup schedule registered.'
      );
    } else {
      console.info(
        'Daily backup scheduling is disabled.'
      );
    }

    console.info('Redis connection verified: PONG.');
    console.info(
      'BullMQ queues initialized: notifications, processing, reports, backups.'
    );

    return {
      notificationQueue,
      reportQueue,
      processingQueue,
      backupQueue
    };
  } catch (error) {
    await Promise.allSettled([
      notificationQueue?.close(),
      processingQueue?.close(),
      reportQueue?.close(),
      backupQueue?.close()
    ]);

    notificationQueue = undefined;
    processingQueue = undefined;
    reportQueue = undefined;
    backupQueue = undefined;

    if (redisClient?.isOpen) {
      await redisClient.quit().catch(() => {});
    }

    redisClient = undefined;

    throw new Error(
      `Failed to initialize Redis queues: ${error.message}`,
      { cause: error }
    );
  }
}

export async function checkRedisReady() {
  if (!isRedisEnabled()) return true;
  if (!redisClient?.isOpen) return false;

  try {
    return (await redisClient.ping()) === 'PONG';
  } catch {
    return false;
  }
}

function requireQueue(queue, name) {
  if (!isRedisEnabled()) {
    throw new Error(
      `${name} queue is unavailable because Redis is disabled.`
    );
  }

  if (!queue) {
    throw new Error(
      `${name} queue is not initialized.`
    );
  }

  return queue;
}

export function getNotificationQueue() {
  return requireQueue(
    notificationQueue,
    'Notification'
  );
}

export function getProcessingQueue() {
  return requireQueue(
    processingQueue,
    'Processing'
  );
}

export function getBackupQueue() {
  return requireQueue(
    backupQueue,
    'Backup'
  );
}

export function getReportQueue() {
  return requireQueue(
    reportQueue,
    'Report'
  );
}

export async function closeQueues() {
  const queues = [
    notificationQueue,
    processingQueue,
    reportQueue,
    backupQueue
  ];

  const results = await Promise.allSettled(
    queues.filter(Boolean).map(queue => queue.close())
  );

  let redisCloseError;

  if (redisClient?.isOpen) {
    try {
      await redisClient.quit();
    } catch (error) {
      redisCloseError = error;
    }
  }

  notificationQueue = undefined;
  processingQueue = undefined;
  reportQueue = undefined;
  backupQueue = undefined;
  redisClient = undefined;

  const queueFailure = results.find(
    result => result.status === 'rejected'
  );

  if (queueFailure) {
    throw queueFailure.reason;
  }

  if (redisCloseError) {
    throw redisCloseError;
  }

  console.info('Redis queues and client closed.');
}
