import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVapiClient } from '../src/vapi.js';

test('a Vapi call that never answers fails after the time limit', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const vapi = createVapiClient({ apiKey: 'k', fetchImpl: hang, timeoutMs: 50 });
  await assert.rejects(vapi.createAssistant({}), /Vapi POST \/assistant failed: no answer after 0s/);
});

test('Vapi errors carry the status and message, never the key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'Invalid Key' }) });
  const vapi = createVapiClient({ apiKey: 'secret-key-123', fetchImpl });
  await assert.rejects(vapi.createPhoneNumber({}), (e) => {
    assert.match(e.message, /failed \(401\): Invalid Key/);
    assert.doesNotMatch(e.message, /secret-key-123/);
    return true;
  });
});

test('a refused connection becomes a readable error', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const vapi = createVapiClient({ apiKey: 'k', fetchImpl });
  await assert.rejects(vapi.getPhoneNumber('pn_1'), /Vapi GET \/phone-number\/pn_1 failed: fetch failed/);
});
