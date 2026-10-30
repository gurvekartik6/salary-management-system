import { Admin } from '../models/index.js';

async function validateAdminSession(req) {
  const user = req.session?.user;

  if (!user || user.role !== 'admin') return null;

  const admin = await Admin.findOne({
    _id: user.id,
    active: true
  })
    .select('_id email mfaEnabled')
    .lean();

  return admin ? user : null;
}

export async function requireAuth(req, res, next) {
  try {
    const user = await validateAdminSession(req);

    if (!user) {
      if (req.session) req.session.destroy(() => {});

      return res.status(401).json({
        error: 'Administrator authentication required or account access revoked'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const user = await validateAdminSession(req);

      if (!user) {
        if (req.session) req.session.destroy(() => {});

        return res.status(401).json({
          error: 'Administrator authentication required or account access revoked'
        });
      }

      if (!roles.includes('admin')) {
        return res.status(403).json({
          error: 'Only administrators may access this system'
        });
      }

      if (
        process.env.NODE_ENV === 'production' &&
        process.env.ADMIN_MFA_REQUIRED !== 'false'
      ) {
        const adminState = await Admin.findById(user.id)
          .select('mfaEnabled')
          .lean();

        const isMfaRoute = String(req.originalUrl || '').startsWith(
          '/api/admin/mfa/'
        );

        if (!adminState?.mfaEnabled && !isMfaRoute) {
          return res.status(403).json({
            error: 'Administrator MFA setup is required before using the system.'
          });
        }

        if (adminState?.mfaEnabled && user.mfaVerified !== true) {
          return res.status(403).json({
            error: 'Administrator MFA verification is required. Sign in again.'
          });
        }
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireOwnerOrAdmin() {
  return requireRole('admin');
}