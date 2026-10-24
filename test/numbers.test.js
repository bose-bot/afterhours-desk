import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakeVapi, validSignup } from './helpers.js';
import { suggestedAreaCodes } from '../src/provision.js';

const areasTried = (vapi) => vapi.calls.filter(([n]) => n === 'createPhoneNumber').map(([, b]) => b.numberDesiredAreaCode ?? 'any');

test('reads the area codes Vapi suggests', () => {
  assert.deepEqual(suggestedAreaCodes('This area code is currently not available. Hint: Try one of 323, 213, 937.'), ['323', '213', '937']);
  assert.deepEqual(suggestedAreaCodes('something else'), []);
});

test('when the shop\'s area code is sold out, a suggested one is used', async () => {
  const vapi = fakeVapi({ availableAreas: ['937'] });
  const t = await startApp({ vapi });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.equal(c.status, 'active');
    assert.deepEqual(areasTried(vapi), ['513', '323', '213', '937']);
  } finally { await t.close(); }
});

test('when no suggested area code works, any available number is used', async () => {
  const vapi = fakeVapi({ availableAreas: [] });
  const t = await startApp({ vapi });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.equal(c.status, 'active');
    assert.equal(c.phoneNumber, '+19995550100');
    assert.equal(areasTried(vapi).at(-1), 'any');
    assert.ok(areasTried(vapi).length <= 6, 'gives up on area codes after a few tries');
  } finally { await t.close(); }
});

test('other phone errors are not retried with different area codes', async () => {
  const vapi = fakeVapi({ failPhone: true });
  const t = await startApp({ vapi });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    assert.equal((await t.db.getClient(r.json.client.id)).status, 'failed');
    assert.equal(areasTried(vapi).length, 1);
  } finally { await t.close(); }
});
