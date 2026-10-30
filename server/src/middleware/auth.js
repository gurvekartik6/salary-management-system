import { Admin } from '../models/index.js';

async function validateAdminSession(req) {
  const user = req.session?.user;

  if (!user || user.role !== 'admin') return null;

  const account = await Admin.findOne({
    _id: user.id,
    active: true
  })
    .select('_id email role')
    .lean();

  if (!account) return null;
  if (account.role !== 'admin' || user.role !== 'admin') return null;
  return { ...user, email: account.email, role: 'admin' };
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

      if (!roles.includes(user.role)) {
        return res.status(403).json({
          error: 'This account does not have permission to access this resource'
        });
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
