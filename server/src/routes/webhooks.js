import { Router } from 'express';
import crypto from 'node:crypto';
import twilio from 'twilio';
import { updateDeliveryFromProvider } from '../services/deliveryState.js';
const router = Router();
router.post('/sms/twilio', async (req, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return res.status(503).send('SMS webhook is not configured');
  const signature = req.get('X-Twilio-Signature') || '';
  const url = `${process.env.PUBLIC_BASE_URL || ''}${req.originalUrl}`;
  if (!twilio.validateRequest(authToken, signature, url, req.body || {})) return res.status(403).send('Invalid signature');
  await updateDeliveryFromProvider({ providerMessageId: req.body?.MessageSid, status: req.body?.MessageStatus, errorCode: req.body?.ErrorCode, provider: 'twilio', eventId: `${req.body?.MessageSid}:${req.body?.MessageStatus}:${req.body?.ErrorCode || ''}` });
  res.sendStatus(204);
});
router.get('/whatsapp', (req, res) => {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) return res.sendStatus(503);
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
});
router.post('/whatsapp', async (req, res) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return res.status(503).send('WhatsApp webhook is not configured');
  const raw = req.rawBody;
  if (!raw) return res.status(400).send('Raw request body unavailable');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const supplied = req.get('X-Hub-Signature-256') || '';
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Invalid signature');
  const changes = req.body?.entry?.flatMap(e => e.changes || []) || [];
  for (const change of changes) for (const status of change.value?.statuses || []) await updateDeliveryFromProvider({ providerMessageId: status.id, status: status.status, errorCode: status.errors?.[0]?.code, provider: 'whatsapp-cloud-api', eventId: `${status.id}:${status.status}:${status.timestamp || ''}` });
  res.sendStatus(204);
});
router.post('/email/generic', async (req, res) => {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Email webhook adapter is not configured' });
  const supplied = String(req.get('X-Email-Webhook-Signature') || '');
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(403).json({ error: 'Invalid signature' });
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0,500) : [];
  for (const event of events) await updateDeliveryFromProvider({ providerMessageId: event.messageId, status: event.status, errorCode: event.errorCode, provider: 'email', eventId: String(event.eventId || `${event.messageId}:${event.status}:${event.timestamp || ''}`) });
  res.sendStatus(204);
});
export default router;
