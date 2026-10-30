
import 'express-async-errors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/uploads.js';
import campaignRoutes from './routes/campaigns.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import publicRoutes from './routes/public.js';
import webhookRoutes from './routes/webhooks.js';
import { audit } from './utils/audit.js';
import { requireRole } from './middleware/auth.js';
import { checkRedisReady } from './services/queue.js';

// Load the root .env explicitly.
// This file is located in server/src/app.js.
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(currentDirectory, '../../.env')
});

const app = express();

app.disable('x-powered-by');
app.set(
  'trust proxy',
  process.env.TRUST_PROXY === 'true' ? 1 : false
);

app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('X-Request-ID', req.id);
  next();
});

app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === 'production'
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"]
            }
          }
        : false,
    crossOriginEmbedderPolicy: false
  })
);

const origins = String(
  process.env.CLIENT_ORIGIN || 'http://localhost:5173'
)
  .split(',')
  .map(origin => origin.trim());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID']
  })
);

app.use(
  express.json({
    limit: '6mb',
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    }
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: '6mb',
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    }
  })
);

app.use(cookieParser());

app.use((req, res, next) => {
  if (
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
    req.path.startsWith('/api/webhooks/')
  ) {
    return next();
  }

  const origin = req.get('origin');

  if (origin && !origins.includes(origin)) {
    return res.status(403).json({
      error: 'Request origin is not allowed'
    });
  }

  next();
});

const sessionSecret = process.env.SESSION_SECRET || '';

if (
  sessionSecret.length < 32 &&
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'SESSION_SECRET must be at least 32 characters in production'
  );
}

if (!process.env.MONGODB_URI) {
  throw new Error(
    'MONGODB_URI is missing. Check the root .env file.'
  );
}

const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  collectionName: 'sessions',
  ttl: Number(process.env.SESSION_MAX_AGE_HOURS || 8) * 3600,
  autoRemove: 'native'
});

app.use(
  session({
    name: process.env.SESSION_COOKIE_NAME || 'sggs.sid',
    secret:
      sessionSecret || 'development-only-secret-change-me-32chars',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:
        Number(process.env.SESSION_MAX_AGE_HOURS || 8) * 3600000,
      path: '/'
    }
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Try again later.'
  }
});

app.use('/api/admin/login', loginLimiter);

// API routes
app.use('/api', authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use(
  '/api/admin/campaigns',
  requireRole('admin'),
  campaignRoutes
);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api', publicRoutes);
app.use('/api/webhooks', webhookRoutes);

// Public assets
const publicAssets = path.resolve(
  process.env.PUBLIC_ASSET_DIR || './server/public-assets'
);

fs.mkdirSync(publicAssets, { recursive: true });

app.use(
  '/site-assets',
  express.static(publicAssets, {
    index: false,
    dotfiles: 'deny',
    immutable: true,
    maxAge: '7d',
    setHeaders(res, filePath) {
      if (!filePath.endsWith('.webp')) {
        res.status(403);
      }
    }
  })
);

// Readiness check
app.get('/api/health/ready', async (_req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        ok: false,
        database: 'not-ready'
      });
    }

    if (!(await checkRedisReady())) {
      return res.status(503).json({
        ok: false,
        database: 'ready',
        queue: 'not-ready'
      });
    }

    return res.json({
      ok: true,
      database: 'ready',
      queue: 'ready',
      time: new Date().toISOString()
    });
  } catch {
    return res.status(503).json({ ok: false });
  }
});

// Production frontend
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve('./server/client-dist');

  app.use(
    express.static(clientDist, {
      index: false,
      dotfiles: 'deny',
      maxAge: '1h'
    })
  );

  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/site-assets')
    ) {
      return next();
    }

    res.sendFile(
      path.join(clientDist, 'index.html'),
      error => error && next(error)
    );
  });
}

// Not found
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    requestId: req.id
  });
});

// Error handler
app.use(async (err, req, res, _next) => {
  const status = Number(
    err.status ||
      err.statusCode ||
      (err.code === 'LIMIT_FILE_SIZE'
        ? 413
        : String(err.code || '').startsWith('LIMIT_')
          ? 400
          : 500)
  );

  console.error(`[${req.id}]`, err.message);

  if (status >= 500) {
    try {
      await audit(
        req,
        'request.error',
        'request',
        req.id,
        'failure',
        {
          status,
          message: err.message
        }
      );
    } catch (auditError) {
      console.error(
        'Failed to record request error:',
        auditError.message
      );
    }
  }

  if (res.headersSent) {
    return;
  }

  const safeMessage =
    status >= 500
      ? 'An internal error occurred. Use the request ID when contacting support.'
      : err.message;

  return res.status(status).json({
    error: safeMessage,
    requestId: req.id
  });
});

export default app;
