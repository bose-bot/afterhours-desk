import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET, ADMIN } from './helpers.js';
import { buildSystemPrompt, toolDefinitions } from '../src/prompt.js';
import { monthKey, callDuration } from '../src/usage.js';

const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };

async function signUp(t, over = {}) {
  const r = await t.req('POST', '/api/signup', { body: validSignup(over) });
  await t.idle();
  return r.json.client.id;
}

test('with an on-call number, urgent calls can be transferred to a person', async () => {
  const t = await startApp();
  try {
    await signUp(t);
    const [, body] = t.vapi.calls.find(([n]) => n === 'createAssistant');
    const transfer = body.model.tools.find((x) => x.type === 'transferCall');
    assert.ok(transfer, 'transfer tool is attached');
    assert.equal(transfer.destinations[0].type, 'number');
    assert.equal(transfer.destinations[0].number, '+15135550100');
    const prompt = body.model.messages[0].content;
    assert.match(prompt, /call take_message with urgency "Emergency" so the team has their details\. Then call transferCall/);
    assert.match(prompt, /Always call take_message before transferCall/);
    assert.match(prompt, /Never give out the on-call number/);
  } finally { await t.close(); }
});

test('without an on-call number there is no transfer, and the script never mentions one', () => {
  const client = { business: 'Solo Air', details: { schedule: { days: [1], start: '08:00', end: '17:00' } } };
  assert.doesNotMatch(buildSystemPrompt(client), /transferCall/);
  assert.equal(toolDefinitions('https://x.example/hook').length, 3);
  assert.equal(buildSystemPrompt({ ...client, status: 'demo', details: { ...client.details, oncall: '+15135550100' } }).includes('transferCall'), false, 'demo lines never transfer');
});

test('the phone number falls back to a person if the assistant cannot answer', async () => {
  const t = await startApp();
  try {
    await signUp(t);
    const [, withOncall] = t.vapi.calls.find(([n]) => n === 'createPhoneNumber');
    assert.deepEqual(withOncall.fallbackDestination, { type: 'number', number: '+15135550100', message: 'Connecting you to the team now.' });

    t.vapi.calls.length = 0;
    await signUp(t, { email: 'solo@shop.example', oncall: '', office: '' });
    const [, noOncall] = t.vapi.calls.find(([n]) => n === 'createPhoneNumber');
    assert.equal(noOncall.fallbackDestination.number, '+15135550142', "falls back to the owner's mobile");
  } finally { await t.close(); }
});

test('Update script also gives shops set up earlier the fallback', async () => {
  const t = await startApp();
  try {
    const id = await signUp(t);
    const res = await t.req('POST', `/api/admin/clients/${id}/update-script`, auth);
    assert.equal(res.status, 200);
    const patch = t.vapi.calls.find(([n]) => n === 'updatePhoneNumber');
    assert.equal(patch[1], (await t.db.getClient(id)).vapiPhoneId);
    assert.equal(patch[2].fallbackDestination.number, '+15135550100');
  } finally { await t.close(); }
});

test('call minutes and cost are counted, and the operator hears at 80% and 100% once each', async () => {
  const t = await startApp({ env: { INCLUDED_MINUTES: '10' } });
  try {
    const id = await signUp(t);
    t.mailer.sent.length = 0;
    const end = (callId, seconds, cost) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, {
      body: { message: { type: 'end-of-call-report', call: { id: callId, customer: { number: '+15135550999' } }, durationSeconds: seconds, cost, analysis: { summary: 'Booked a visit.' } } },
    });
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const alerts = () => t.mailer.sent.filter((m) => m.to === 'owner@desk.example.com' && /call minutes/.test(m.subject));

    await end('c1', 150, 0.24); await settle();
    assert.equal(alerts().length, 0, '3 of 10 minutes: no alert');
    await end('c2', 350, 0.55); await settle();
    assert.equal(alerts().length, 1); assert.match(alerts()[0].subject, /used 80% of its call minutes/);
    await end('c3', 120, 0.19); await settle();
    assert.equal(alerts().length, 2); assert.match(alerts()[1].subject, /used all of its call minutes/);
    assert.match(alerts()[1].text, /Calls are still being answered/);
    await end('c4', 60, 0.1); await settle();
    assert.equal(alerts().length, 2, 'no repeat alerts in the same month');

    const { json } = await t.req('GET', '/api/admin/clients', auth);
    const u = json.clients.find((c) => c.id === id).usage;
    assert.equal(u.calls, 4);
    assert.equal(u.minutes, 12); // 680 seconds rounds up
    assert.equal(u.cost, 1.08);
    assert.equal(u.included, 10);
  } finally { await t.close(); }
});

test('reports that never reached the server are recovered from Vapi and emailed once', async () => {
  const t = await startApp();
  try {
    const id = await signUp(t);
    const c = await t.db.getClient(id);
    t.mailer.sent.length = 0;
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    t.vapi.callList = [
      { id: 'lost_1', assistantId: c.vapiAssistantId, status: 'ended', startedAt: ago(14), endedAt: ago(10), cost: 0.31,
        customer: { number: '+15135550177' }, analysis: { summary: 'No heat, wants a callback.' }, artifact: { transcript: 'AI: Thanks for calling…' } },
      { id: 'just_ended', assistantId: c.vapiAssistantId, status: 'ended', startedAt: ago(2), endedAt: ago(1) },
      { id: 'live_now', assistantId: c.vapiAssistantId, status: 'in-progress', startedAt: ago(1) },
    ];

    const first = await t.req('POST', '/api/admin/recover-calls', auth);
    assert.equal(first.status, 200);
    assert.equal(first.json.recovered, 1, 'only the call that ended a while ago');
    const saved = await t.db.getCall('lost_1');
    assert.equal(saved.source, 'recovered');
    assert.equal(saved.duration_s, 240);
    assert.equal(saved.summary, 'No heat, wants a callback.');
    const summaries = () => t.mailer.sent.filter((m) => m.to === 'pat@maplerow.example');
    assert.equal(summaries().length, 1);
    assert.match(summaries()[0].text, /arrived late because our server could not be reached/);

    assert.equal((await t.req('POST', '/api/admin/recover-calls', auth)).json.recovered, 0, 'second run finds nothing new');
    await t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, {
      body: { message: { type: 'end-of-call-report', call: { id: 'lost_1' }, analysis: { summary: 'No heat, wants a callback.' } } },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(summaries().length, 1, 'a very late webhook does not email the owner again');
  } finally { await t.close(); }
});

test('health check confirms the database answers', async () => {
  const t = await startApp();
  try {
    const r = await t.req('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally { await t.close(); }
});

test('usage helpers: month in the shop time zone, and duration from any field Vapi sends', () => {
  assert.equal(monthKey(new Date('2026-12-01T03:00:00Z'), 'America/New_York'), '2026-11', '10 PM Nov 30 in Cincinnati');
  assert.equal(callDuration({ durationSeconds: 61 }), 61);
  assert.equal(callDuration({ durationMs: 90_500 }), 90.5);
  assert.equal(callDuration({ startedAt: '2026-11-05T01:00:00Z', endedAt: '2026-11-05T01:03:30Z' }), 210);
  assert.equal(callDuration({}), null);
});
