import crypto from 'node:crypto';
import { AuditLog } from '../models/index.js';

const sensitiveKeys = /password|token|secret|salaryAmount|messageBody|body|authorization|cookie/i;
function redact(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitiveKeys.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  if (typeof value === 'string') return value.slice(0, 300);
  return value;
}
export async function audit(req, action, targetType = '', targetId = '', result = 'success', metadata = {}) {
  try {
    const actor = req?.user || req?.session?.user || {};
    const ip = String(req?.ip || 'unknown');
    await AuditLog.create({
      actorId: String(actor.id || actor._id || 'system'), actorRole: actor.role || 'system', actorEmail: actor.email,
      action, targetType, targetId: String(targetId || ''), result,
      requestId: req?.id || req?.headers?.['x-request-id'],
      ipHash: crypto.createHash('sha256').update(`${process.env.AUDIT_IP_SALT || 'configure-audit-ip-salt'}:${ip}`).digest('hex'),
      metadata: redact(metadata)
    });
  } catch (error) { console.error('Audit write failed:', error.message); }
}
