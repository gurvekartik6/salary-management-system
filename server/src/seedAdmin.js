import 'dotenv/config';
import argon2 from 'argon2';
import { connectDatabase } from './config/db.js';
import { Admin } from './models/index.js';

async function seed() {
  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  if (!email || !password) throw new Error('Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD in your private .env before running this one-time command.');
  if (password.length < 14) throw new Error('Bootstrap password must be at least 14 characters.');
  await connectDatabase();
  const exists = await Admin.findOne({ email });
  if (exists) throw new Error('Admin already exists. Use the protected password-change workflow instead.');
  await Admin.create({ email, passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }), active: true });
  console.info(`Admin created for ${email}. Remove ADMIN_BOOTSTRAP_PASSWORD from the environment after provisioning.`);
  process.exit(0);
}
seed().catch(err => { console.error(err.message); process.exit(1); });
