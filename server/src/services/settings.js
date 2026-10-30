import { SystemSetting } from '../models/index.js';
const cache = new Map();
const CACHE_TTL_MS = 30000;
export async function getSetting(key, fallback = {}) {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await SystemSetting.findOne({ key }).lean();
  const value = row?.value ?? fallback;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
export function invalidateSetting(key) { cache.delete(key); }
export async function getNumberSetting(key, property, fallback) {
  const value = await getSetting(key, {});
  const n = Number(value?.[property]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
