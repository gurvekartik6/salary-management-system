import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, isValidEmail } from '../src/utils/contacts.js';

test('normalizes ten-digit Indian mobile numbers to E.164', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
});
test('rejects invalid phone numbers', () => {
  assert.equal(normalizePhone('12345'), '');
  assert.equal(normalizePhone('abc'), '');
  assert.equal(normalizePhone('+00012345678'), '');
});
test('email validation accepts optional empty values but rejects malformed addresses', () => {
  assert.equal(isValidEmail(''), true);
  assert.equal(isValidEmail('staff@sggs.ac.in'), true);
  assert.equal(isValidEmail('staff@@sggs.ac.in'), false);
  assert.equal(isValidEmail('staff@sggs'), false);
});
