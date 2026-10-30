import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Allowlist, Incharge } from '../models/index.js';
import { audit } from '../utils/audit.js';

export function configurePassport() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) {
    console.warn('Google OAuth not configured; incharge Google sign-in will be unavailable until credentials are added.');
    return passport;
  }
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = String(profile.emails?.[0]?.value || '').trim().toLowerCase();
      const verified = profile._json?.email_verified === true;
      const domain = String(process.env.COLLEGE_EMAIL_DOMAIN || 'sggs.ac.in').toLowerCase().replace(/^@/, '');
      if (!verified || !email.endsWith(`@${domain}`)) {
        await audit(req, 'auth.google.denied_domain', 'identity', profile.id, 'denied', { email });
        return done(null, false, { message: 'Use a verified @sggs.ac.in account.' });
      }
      const allowed = await Allowlist.findOne({ email, active: true });
      if (!allowed) {
        await audit(req, 'auth.google.denied_allowlist', 'identity', profile.id, 'denied', { email });
        return done(null, false, { message: 'Your college account has not been authorized by the administrator.' });
      }
      let user = await Incharge.findOne({ googleSub: profile.id });
      if (user && user.email !== email) {
        await audit(req, 'auth.google.denied_identity_change', 'identity', profile.id, 'denied', { email });
        return done(null, false, { message: 'The Google account does not match the registered identity.' });
      }
      if (!user) user = await Incharge.create({ googleSub: profile.id, email, name: profile.displayName || email });
      if (!user.active) return done(null, false, { message: 'This incharge account is disabled.' });
      user.lastLoginAt = new Date(); await user.save();
      return done(null, { id: String(user._id), role: 'incharge', email: user.email, name: user.name });
    } catch (error) { return done(error); }
  }));
  return passport;
}
