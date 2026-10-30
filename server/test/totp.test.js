import test from 'node:test';
import assert from 'node:assert/strict';
import { createTotpSecret, encryptTotpSecret, decryptTotpSecret, generateTotpCode, verifyTotp } from '../src/utils/totp.js';

process.env.MFA_ENCRYPTION_KEY = 'test-only-mfa-encryption-key-32-characters-long';

test('TOTP implementation matches the RFC 6238 SHA-1 test vector at 59 seconds', () => {
  assert.equal(generateTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('TOTP codes validate for their time step and reject invalid values', () => {
  const secret = createTotpSecret();
  const now = 1_800_000_000_000;
  const code = generateTotpCode(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, now), true);
  assert.equal(verifyTotp(secret, 'bad-code', now), false);
  assert.equal(verifyTotp(secret, '0000000', now), false);
});

test('MFA secrets encrypt and decrypt, and tampering is rejected', () => {
  const secret = createTotpSecret();
  const encrypted = encryptTotpSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptTotpSecret(encrypted), secret);
  const [iv, tag, ciphertext] = encrypted.split('.');
  const altered = `${iv}.${tag}.${ciphertext.slice(0, -1)}${ciphertext.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => decryptTotpSecret(altered));
});
