import { Router } from 'express';
import { SiteContent } from '../models/index.js';
const router = Router();
router.get('/site/content', async (_req, res) => {
  const items = await SiteContent.find({ status: 'published', key: { $in: ['home','header','footer','navigation','uiCopy'] } }).sort({ key: 1, version: -1 }).lean();
  const content = {};
  for (const item of items) if (!content[item.key]) content[item.key] = item.content;
  res.set('Cache-Control', 'private, max-age=60'); res.json({ content });
});
router.get('/health/live', (_req, res) => res.json({ ok: true, service: 'sggs-salary-api', time: new Date().toISOString() }));
export default router;
