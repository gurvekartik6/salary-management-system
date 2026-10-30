import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('SGGSBK01');
const HEADER_LENGTH = 8 + 16 + 12 + 16;
function getKey(passphrase, salt) { return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
async function encrypt(input, output) {
  const passphrase = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
  if (!passphrase || passphrase.length < 24) throw new Error('BACKUP_ENCRYPTION_PASSPHRASE must contain at least 24 characters');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = getKey(passphrase, salt);
  const tempCipher = `${output}.cipher.tmp`;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    await pipeline(createReadStream(input), cipher, createWriteStream(tempCipher, { mode: 0o600 }));
    const tag = cipher.getAuthTag();
    await new Promise((resolve, reject) => {
      const out = createWriteStream(output, { mode: 0o600 });
      out.on('error', reject); out.on('finish', resolve);
      out.write(Buffer.concat([MAGIC, salt, iv, tag]));
      const source = createReadStream(tempCipher); source.on('error', reject); source.on('end', () => out.end()); source.pipe(out, { end: false });
    });
  } finally { key.fill(0); await fsp.rm(tempCipher, { force: true }).catch(() => {}); }
}
async function decrypt(input, output) {
  const passphrase = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
  if (!passphrase || passphrase.length < 24) throw new Error('BACKUP_ENCRYPTION_PASSPHRASE must contain at least 24 characters');
  const handle = await fsp.open(input, 'r');
  let header;
  try { header = Buffer.alloc(HEADER_LENGTH); const { bytesRead } = await handle.read(header, 0, HEADER_LENGTH, 0); if (bytesRead !== HEADER_LENGTH) throw new Error('Backup file is truncated'); }
  finally { await handle.close(); }
  if (!header.subarray(0,8).equals(MAGIC)) throw new Error('Backup format is not recognized');
  const salt = header.subarray(8,24), iv = header.subarray(24,36), tag = header.subarray(36,52), key = getKey(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    await pipeline(createReadStream(input, { start: HEADER_LENGTH }), decipher, createWriteStream(output, { mode: 0o600 }));
  } catch (error) { await fsp.rm(output, { force: true }).catch(() => {}); throw new Error(`Backup authentication/decryption failed: ${error.message}`); }
  finally { key.fill(0); }
}
const [mode, input, output] = process.argv.slice(2);
if (!['encrypt','decrypt'].includes(mode) || !input || !output) { console.error('Usage: node encrypt-backup.mjs encrypt|decrypt INPUT OUTPUT'); process.exit(2); }
try { if (mode === 'encrypt') await encrypt(path.resolve(input), path.resolve(output)); else await decrypt(path.resolve(input), path.resolve(output)); }
catch (error) { console.error(error.message); process.exit(1); }
