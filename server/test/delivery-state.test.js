import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canApplyProviderStatus,
  mapProviderStatus
} from '../src/services/deliveryState.js';

test('maps provider delivery statuses to internal statuses', () => {
  assert.equal(mapProviderStatus('delivered'), 'delivered');
  assert.equal(mapProviderStatus('read'), 'delivered');
  assert.equal(mapProviderStatus('undelivered'), 'failed');
  assert.equal(mapProviderStatus('unknown-provider-status'), undefined);
});

test('does not allow provider updates to regress terminal delivery states', () => {
  assert.equal(canApplyProviderStatus('delivered', 'sent'), false);
  assert.equal(canApplyProviderStatus('bounced', 'delivered'), false);
  assert.equal(canApplyProviderStatus('cancelled', 'sent'), false);
  assert.equal(canApplyProviderStatus('failed', 'sent'), false);
  assert.equal(canApplyProviderStatus('unknown', 'delivered'), true);
  assert.equal(canApplyProviderStatus('sent', 'delivered'), true);
});
