
import dns from 'node:dns';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(process.cwd(), 'server', '.env')
];

const envPath = envCandidates.find(
  candidate =>
    fs.existsSync(candidate) &&
    fs.statSync(candidate).isFile()
);

if (!envPath) {
  throw new Error(
    `Could not find .env. Checked:\n${envCandidates.join('\n')}`
  );
}

const envResult = dotenv.config({
  path: envPath
});

if (envResult.error) {
  throw new Error(
    `Could not load .env: ${envResult.error.message}`
  );
}

console.info(`Environment loaded from: ${envPath}`);

const configuredDnsServers = String(
  process.env.MONGODB_DNS_SERVERS || ''
)
  .split(',')
  .map(server => server.trim())
  .filter(Boolean);

if (configuredDnsServers.length > 0) {
  dns.setServers(configuredDnsServers);
  console.info(
    `Custom DNS servers configured for MongoDB SRV resolution: ${configuredDnsServers.join(', ')}`
  );
}

const { connectDatabase } = await import('./config/db.js');
const { runRetentionTasks } = await import(
  './services/retention.js'
);
const { bootstrapSettings } = await import(
  './services/bootstrapSettings.js'
);

function isRedisEnabled() {
  return !['false', '0', 'no', 'off'].includes(
    String(process.env.REDIS_ENABLED ?? 'true')
      .trim()
      .toLowerCase()
  );
}

const redisEnabled = isRedisEnabled();

let initializeQueues;
let closeQueues;
let startWorkers;
let reconcileQueueTasks;

if (redisEnabled) {
  ({
    initializeQueues,
    closeQueues
  } = await import('./services/queue.js'));

  ({
    startWorkers,
    reconcileQueueTasks
  } = await import('./workers/index.js'));
} else {
  console.warn(
    'REDIS_ENABLED is false. BullMQ queues and workers will not start.'
  );
}

let app;
let server;
let workers;
let retentionTimer;
let queueReconcileTimer;
let shuttingDown = false;

function validateProductionEnvironment() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const required = [
    'MONGODB_URI',
    'SESSION_SECRET',
    'REDIS_URL'
  ];

  const missing = required.filter(
    name => !process.env[name]?.trim()
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(', ')}`
    );
  }

  if (process.env.SESSION_SECRET.length < 32) {
    throw new Error(
      'SESSION_SECRET must contain at least 32 characters in production.'
    );
  }

  if (!redisEnabled) {
    throw new Error(
      'REDIS_ENABLED cannot be false in production because queue-dependent workflows are required.'
    );
  }
}

async function start() {
  validateProductionEnvironment();

  if (!process.env.MONGODB_URI) {
    throw new Error(
      `MONGODB_URI is missing. Check the loaded .env file: ${envPath}`
    );
  }

  await connectDatabase();

  const appModule = await import('./app.js');
  app = appModule.default;

  await bootstrapSettings();

  if (redisEnabled) {
    await initializeQueues();

    workers = await startWorkers();

    await reconcileQueueTasks().catch(error => {
      console.error(
        'Initial queue reconciliation failed:',
        error.message
      );
    });

    queueReconcileTimer = setInterval(() => {
      reconcileQueueTasks().catch(error => {
        console.error(
          'Queue reconciliation failed:',
          error.message
        );
      });
    }, 60 * 1000);

    console.info(
      'Redis queues and background workers enabled.'
    );
  } else {
    console.warn(
      'Redis disabled: queue-based jobs, workers, and reconciliation will not run.'
    );
  }

  await runRetentionTasks().catch(error => {
    console.error(
      'Initial retention sweep failed:',
      error.message
    );
  });

  retentionTimer = setInterval(() => {
    runRetentionTasks().catch(error => {
      console.error(
        'Retention sweep failed:',
        error.message
      );
    });
  }, 24 * 60 * 60 * 1000);

  const port = Number(process.env.PORT || 4000);

  server = app.listen(port, () => {
    console.info(
      `SGGS Salary Notification API listening on port ${port}`
    );
  });

  console.info('Application startup completed.');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(`Received ${signal}; shutting down.`);

  if (retentionTimer) {
    clearInterval(retentionTimer);
  }

  if (queueReconcileTimer) {
    clearInterval(queueReconcileTimer);
  }

  let shutdownFailed = false;

  if (server) {
    await new Promise(resolve => {
      server.close(error => {
        if (error) {
          shutdownFailed = true;
          console.error(
            'Error closing HTTP server:',
            error.message
          );
        }

        resolve();
      });
    });
  }

  try {
    await workers?.close?.();
  } catch (error) {
    shutdownFailed = true;
    console.error(
      'Error closing workers:',
      error.message
    );
  }

  if (redisEnabled && closeQueues) {
    try {
      await closeQueues();
    } catch (error) {
      shutdownFailed = true;
      console.error(
        'Error closing queues:',
        error.message
      );
    }
  }

  try {
    const mongooseModule = await import('mongoose');

    await mongooseModule.default.connection.close();
    console.info('MongoDB connection closed.');
  } catch (error) {
    shutdownFailed = true;
    console.error(
      'Error closing MongoDB connection:',
      error.message
    );
  }

  process.exitCode = shutdownFailed ? 1 : 0;
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

start().catch(error => {
  console.error('Startup failed:', error);
  process.exitCode = 1;
});
