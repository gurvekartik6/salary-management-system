import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { BackupRecord } from '../models/index.js';
const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../../../scripts/backup.sh', import.meta.url));
const backupDir = path.resolve(process.env.BACKUP_DIR || './private-backups');
export async function createEncryptedBackup(backupId) {
  const record = await BackupRecord.findById(backupId);
  if (!record) throw new Error('Backup record not found');
  record.status = 'running'; record.startedAt = new Date(); await record.save();
  try {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const { stdout } = await execFileAsync('bash', [scriptPath], { env: { ...process.env, BACKUP_REFERENCE: record.reference, BACKUP_DIR: backupDir }, timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = Object.fromEntries(stdout.split(/\r?\n/).map(line => line.split('=').length >= 2 ? [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)] : null).filter(Boolean));
    const backupPath = path.resolve(parsed.BACKUP_PATH || '');
    if (path.dirname(backupPath) !== backupDir) throw new Error('Backup script returned an invalid path');
    const checksum = parsed.BACKUP_SHA256 || crypto.createHash('sha256').update(await fs.readFile(backupPath)).digest('hex');
    const stat = await fs.stat(backupPath);
    record.storageReference = backupPath; record.remoteReference = parsed.BACKUP_REMOTE_REFERENCE || undefined; record.checksum = checksum; record.sizeBytes = stat.size; record.status = 'completed'; record.completedAt = new Date(); await record.save();
    return record;
  } catch (error) {
    record.status = 'failed'; record.error = String(error.stderr || error.message || 'Backup failed').replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[database-uri-redacted]').slice(0, 500); record.completedAt = new Date(); await record.save(); throw error;
  }
}
export async function verifyEncryptedBackup(backupId) {
  const record = await BackupRecord.findById(backupId).select('+storageReference');
  if (!record || !record.storageReference || !['completed','verified'].includes(record.status)) throw new Error('Completed backup not found');
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(record.storageReference)) hash.update(chunk);
  const checksum = hash.digest('hex');
  if (checksum !== record.checksum) { record.status = 'failed'; record.error = 'Checksum verification failed'; await record.save(); throw new Error('Backup checksum verification failed'); }
  record.status = 'verified'; record.verifiedAt = new Date(); await record.save(); return record;
}
export function getBackupDirectory() { return backupDir; }
