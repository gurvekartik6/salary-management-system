import { Router } from 'express';
import crypto from 'node:crypto';
import twilio from 'twilio';
import { DeliveryJob, DeliveryAttempt, Campaign, ProviderEvent } from '../models/index.js';
const router = Router();
async function updateDelivery(providerMessageId, status, errorCode = '', provider = 'unknown', eventId = '') {
  if (!providerMessageId) return null;
  const job = await DeliveryJob.findOne({ providerMessageId }); if (!job) return null;
  const mapped = ({ delivered: 'delivered', read: 'delivered', undelivered: 'failed', failed: 'failed', bounced: 'bounced', sent: 'sent', accepted: 'sent' })[String(status).toLowerCase()];
  if (!mapped) return job;
  if (['delivered','bounced'].includes(job.status)) return job;
  if (job.status === 'failed' && mapped === 'sent') return job;
  job.status = mapped; if (mapped === 'delivered') job.deliveredAt = new Date(); if (errorCode) job.lastErrorCode = String(errorCode).slice(0,100); await job.save();
  let newEvent = true;
  if (eventId) {
    try { await ProviderEvent.create({ provider, eventId: String(eventId).slice(0,300), providerMessageId, status: mapped }); }
    catch (error) { if (error.code === 11000) newEvent = false; else throw error; }
  }
  if (newEvent) await DeliveryAttempt.create({ job: job._id, provider, attemptNumber: job.attempts, status: mapped, providerMessageId, errorCode, finishedAt: new Date() });
  const counts = await DeliveryJob.aggregate([{ $match: { campaign: job.campaign } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const c = Object.fromEntries(counts.map(x => [x._id, x.count])); const campaign = await Campaign.findById(job.campaign);
  if (campaign) {
    campaign.counters = { total: Object.values(c).reduce((a,b)=>a+b,0), queued: (c.queued||0)+(c.sending||0), sent: c.sent||0, delivered: c.delivered||0, failed: c.failed||0, bounced: c.bounced||0, unknown: c.unknown||0 };
    if (!['cancelled','cancelling','paused','rejected'].includes(campaign.status) && campaign.counters.queued === 0) { campaign.status = campaign.counters.failed || campaign.counters.bounced || campaign.counters.unknown ? 'partial_failure' : 'completed'; campaign.completedAt = new Date(); }
    await campaign.save();
  }
  return job;
}
router.post('/sms/twilio', async (req, res) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return res.status(503).send('SMS webhook is not configured');
  const signature = req.get('X-Twilio-Signature') || '';
  const url = `${process.env.PUBLIC_BASE_URL || ''}${req.originalUrl}`;
  if (!twilio.validateRequest(authToken, signature, url, req.body || {})) return res.status(403).send('Invalid signature');
  await updateDelivery(req.body?.MessageSid, req.body?.MessageStatus, req.body?.ErrorCode, 'twilio', `${req.body?.MessageSid}:${req.body?.MessageStatus}:${req.body?.ErrorCode || ''}`);
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
  for (const change of changes) for (const status of change.value?.statuses || []) await updateDelivery(status.id, status.status, status.errors?.[0]?.code, 'whatsapp-cloud-api', `${status.id}:${status.status}:${status.timestamp || ''}`);
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
  for (const event of events) await updateDelivery(event.messageId, event.status, event.errorCode, 'email', String(event.eventId || `${event.messageId}:${event.status}:${event.timestamp || ''}`));
  res.sendStatus(204);
});
export default router;
