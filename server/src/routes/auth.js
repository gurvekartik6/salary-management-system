import { Router } from 'express';
import argon2 from 'argon2';
import { Admin } from '../models/index.js';
import { audit } from '../utils/audit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function destroySession(req) {
  return new Promise(resolve => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => error ? reject(error) : resolve());
  });
}

router.get('/auth/me', async (req, res) => {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser || sessionUser.role !== 'admin') {
      if (sessionUser) await destroySession(req);
      return res.json({ authenticated: false, user: null });
    }

    const account = await Admin.findOne({
      _id: sessionUser.id,
      active: true
    }).select('_id email name role');

    if (!account) {
      await destroySession(req);
      return res.json({ authenticated: false, user: null });
    }

    sessionUser.email = account.email;
    sessionUser.name = account.email;
    sessionUser.role = 'admin';
    await saveSession(req);
    return res.json({ authenticated: true, user: sessionUser });
  } catch (error) {
    console.error('Session check failed:', error.message);
    return res.status(500).json({ error: 'Unable to verify session' });
  }
});

router.post('/admin/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password || email.length > 254 || password.length > 256) {
      return res.status(400).json({ error: 'Enter your administrator email and password' });
    }

    const admin = await Admin.findOne({ email, active: true, role: 'admin' }).select('+passwordHash');
    const passwordValid = admin?.passwordHash
      ? await argon2.verify(admin.passwordHash, password).catch(() => false)
      : false;

    if (!admin || !passwordValid) {
      await audit(req, 'auth.admin.login_failed', 'admin', email, 'failure', { email })
        .catch(error => console.error('Failed-login audit error:', error.message));
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => error ? reject(error) : resolve());
    });

    req.session.user = {
      id: String(admin._id),
      role: 'admin',
      email: admin.email,
      name: admin.email
    };

    admin.lastLoginAt = new Date();
    await admin.save();
    await saveSession(req);

    await audit(
      { ...req, user: req.session.user },
      'auth.admin.login',
      'admin',
      admin._id,
      'success'
    ).catch(error => console.error('Admin login audit error:', error.message));

    return res.json({ ok: true, user: req.session.user });
  } catch (error) {
    console.error('Admin login failed:', error.message);
    return res.status(500).json({ error: 'Unable to sign in. Check the server logs.' });
  }
});

async function logoutHandler(req, res) {
  try {
    if (req.session?.user) {
      await audit(req, 'auth.admin.logout', 'session', req.sessionID)
        .catch(error => console.error('Logout audit error:', error.message));
    }
    await destroySession(req);
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'sggs.sid');
    return res.json({ ok: true });
  } catch (error) {
    console.error('Logout failed:', error.message);
    return res.status(500).json({ error: 'Unable to sign out' });
  }
}

router.post('/auth/logout', requireAuth, logoutHandler);
router.post('/admin/logout', requireRole('admin'), logoutHandler);

router.get('/admin/me', requireRole('admin'), (req, res) => {
  return res.json({ user: req.session.user });
});

router.post('/admin/password/change', requireRole('admin'), async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = req.body?.newPassword;

    if (typeof newPassword !== 'string' || newPassword.length < 14 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be between 14 and 128 characters' });
    }

    const admin = await Admin.findById(req.session.user.id).select('+passwordHash');
    const valid = admin?.passwordHash
      ? await argon2.verify(admin.passwordHash, currentPassword).catch(() => false)
      : false;

    if (!admin || !valid) return res.status(401).json({ error: 'Current password is incorrect' });

    admin.passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1
    });
    await admin.save();
    await audit(req, 'admin.password.changed', 'admin', admin._id);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Password change failed:', error.message);
    return res.status(500).json({ error: 'Unable to change password' });
  }
});

export default router;
