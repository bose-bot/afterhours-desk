import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET } from './helpers.js';

// Friday 2026-10-23, 9:30 AM Eastern.
const NOW = new Date('2026-10-23T13:30:00Z');

async function liveClient() {
  const t = await startApp({ now: () => NOW });
  const r = await t.req('POST', '/api/signup', { body: validSignup() });
  await t.idle();
  t.mailer.sent.length = 0;
  const id = r.json.client.id;
  const hook = (message, { token = SECRET, client = id } = {}) =>
    t.req('POST', `/api/vapi/webhook?client=${client}&token=${encodeURIComponent(token)}`, { body: { message } });
  const tool = async (name, args, callId = 'call_1') => {
    const res = await hook({ type: 'tool-calls', call: { id: callId }, toolCallList: [{ id: `tc_${name}`, type: 'function', function: { name, arguments: args } }] });
    assert.equal(res.status, 200);
    assert.equal(res.json.results[0].toolCallId, `tc_${name}`);
    assert.equal(typeof res.json.results[0].result, 'string', 'Vapi requires a flat string result');
    return JSON.parse(res.json.results[0].result);
  };
  return { t, id, hook, tool };
}

test('webhook rejects requests without the secret', async () => {
  const { t, hook } = await liveClient();
  try {
    assert.equal((await hook({ type: 'tool-calls' }, { token: 'wrong' })).status, 401);
    const viaHeader = await t.req('POST', `/api/vapi/webhook?client=x`, { body: { message: { type: 'status-update' } }, headers: { 'x-vapi-secret': SECRET } });
    assert.equal(viaHeader.status, 200);
  } finally { await t.close(); }
});

test('a caller can check times, book one, and the same window cannot be double-booked', async () => {
  const { t, id, tool } = await liveClient();
  try {
    const avail = await tool('check_availability', {});
    // Open until 4 PM, it's 9:30 AM Friday: 8-10 has started and 10-12 is inside the 1-hour lead, so 12-2 PM is first.
    assert.equal(avail.slots[0].slot_start, '2026-10-23T16:00:00.000Z');
    assert.match(avail.slots[0].label, /Friday, October 23, 12 PM to 2 PM/);

    const args = { slot_start: avail.slots[0].slot_start, name: 'Dana R', phone: '5135550123', address: '14 Elm St, Mason', issue: 'AC blowing warm air', urgency: 'Priority' };
    assert.deepEqual(await tool('book_appointment', args), { booked: true, window: avail.slots[0].label });
    assert.equal((await tool('book_appointment', args, 'call_2')).booked, false);

    const next = await tool('check_availability', {});
    assert.notEqual(next.slots[0].slot_start, avail.slots[0].slot_start, 'booked window disappears');

    const made = await tool('book_appointment', { ...args, slot_start: '2026-10-24T12:00:00.000Z' });
    assert.equal(made.booked, false, 'Saturday is closed, so invented times are refused');

    assert.equal(t.db.listBookings(id).length, 1);
  } finally { await t.close(); }
});

test('messages are saved and the owner is emailed a summary when the call ends', async () => {
  const { t, id, tool, hook } = await liveClient();
  try {
    assert.deepEqual(await tool('take_message', { name: 'Sam', phone: '5135550999', issue: 'Smells gas near furnace', urgency: 'Emergency' }, 'call_9'), { saved: true });

    const end = await hook({
      type: 'end-of-call-report', endedReason: 'customer-ended-call',
      call: { id: 'call_9', customer: { number: '+15135550999' } },
      analysis: { summary: 'Caller reported a gas smell; told to leave and call 911.' },
      artifact: { transcript: 'AI: Thanks for calling...' },
    });
    assert.equal(end.status, 200);
    await new Promise((r) => setImmediate(r));

    const [call] = t.db.listCalls(id);
    assert.equal(call.summary, 'Caller reported a gas smell; told to leave and call 911.');
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, 'pat@maplerow.example');
    assert.match(t.mailer.sent[0].subject, /^EMERGENCY · Call summary: Sam/);
    assert.match(t.mailer.sent[0].text, /MESSAGE \[Emergency\]: Sam 5135550999 \| Smells gas/);
  } finally { await t.close(); }
});

test('unknown client gets a safe tool answer instead of an error', async () => {
  const { t, tool } = await liveClient();
  try {
    const res = await t.req('POST', `/api/vapi/webhook?client=nope&token=${SECRET}`, {
      body: { message: { type: 'tool-calls', toolCallList: [{ id: 'a', function: { name: 'check_availability', arguments: {} } }] } },
    });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.json.results[0].result).error, /Take a message/);
    void tool;
  } finally { await t.close(); }
});
