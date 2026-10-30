export function normalizePhone(value, defaultCountryCode = '91') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  let normalized;
  if (raw.startsWith('+')) normalized = `+${digits}`;
  else if (digits.length === 10) normalized = `+${defaultCountryCode}${digits}`;
  else if (digits.length === 12 && digits.startsWith(defaultCountryCode)) normalized = `+${digits}`;
  else return '';
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}
export function isValidEmail(value) { return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()); }
