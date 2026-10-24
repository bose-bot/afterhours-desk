import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakeVapi, validSignup, SECRET, ADMIN } from './helpers.js';

const auth = { Authorization: `Bearer ${ADMIN}` };

test('sign-up goes live automatically: assistant, number, emails', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    assert.equal(r.status, 202);
    const id = r.json.client.id;
    await t.idle();

    const client = t.db.getClient(id);
    assert.equal(client.status, 'active');
    assert.equal(client.phoneNumber, '+15135550199');
    assert.equal(client.phone, '+15135550142');

    const [[, assistant], [, phone]] = t.vapi.calls;
    assert.match(assistant.model.messages[0].content, /Maple Row Heating & Air/);
    assert.equal(assistant.model.tools.length, 3);
    assert.equal(assistant.server.url, `https://desk.example.com/api/vapi/webhook?client=${id}&token=${SECRET}`);
    assert.deepEqual(phone, { provider: 'vapi', assistantId: client.vapiAssistantId, name: 'Maple Row Heating & Air', numberDesiredAreaCode: '513' });

    const subjects = t.mailer.sent.map((m) => `${m.to}: ${m.subject}`);
    assert.deepEqual(subjects, [
      'pat@maplerow.example: Your AfterHours Desk receptionist is live',
      'owner@desk.example.com: New client live: Maple Row Heating & Air',
    ]);
    assert.match(t.mailer.sent[0].text, /\(513\) 555-0199/);

    const status = await t.req('GET', `/api/signup/${id}`);
    assert.deepEqual(status.json.client, { id, business: 'Maple Row Heating & Air', status: 'active', phoneNumber: '+15135550199' });
    assert.equal(status.json.client.email, undefined, 'status endpoint must not expose contact details');
  } finally { await t.close(); }
});

test('a number assigned late is picked up by polling', async () => {
  const t = await startApp({ vapi: fakeVapi({ numberLater: true }) });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    assert.equal(t.db.getClient(r.json.client.id).phoneNumber, '+15135550177');
  } finally { await t.close(); }
});

test('failed number step rolls back the assistant, alerts the operator, and can be retried', async () => {
  const vapi = fakeVapi({ failPhone: true });
  const t = await startApp({ vapi });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    const id = r.json.client.id;
    await t.idle();

    let c = t.db.getClient(id);
    assert.equal(c.status, 'failed');
    assert.match(c.error, /no numbers available/);
    assert.equal(c.vapiAssistantId, null);
    assert.ok(vapi.calls.some(([name]) => name === 'deleteAssistant'));
    assert.deepEqual(t.mailer.sent.map((m) => m.subject), ['Setup failed: Maple Row Heating & Air']);

    vapi.failPhone = false;
    assert.equal((await t.req('POST', `/api/admin/clients/${id}/retry`, { headers: auth })).status, 202);
    await t.idle();
    c = t.db.getClient(id);
    assert.equal(c.status, 'active');
    assert.ok(c.phoneNumber);
  } finally { await t.close(); }
});

test('approval mode waits for the operator', async () => {
  const t = await startApp({ env: { PROVISION_MODE: 'approval' } });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    const id = r.json.client.id;
    await t.idle();
    assert.equal(t.db.getClient(id).status, 'pending_approval');
    assert.equal(t.vapi.calls.length, 0);
    assert.match(t.mailer.sent[0].subject, /Approve new sign-up/);

    assert.equal((await t.req('POST', `/api/admin/clients/${id}/approve`, { headers: auth })).status, 202);
    await t.idle();
    assert.equal(t.db.getClient(id).status, 'active');
  } finally { await t.close(); }
});

test('sign-up guards: validation, honeypot, duplicates, rate limit, capacity', async () => {
  const t = await startApp({ env: { MAX_CLIENTS: '2', SIGNUPS_PER_IP_PER_HOUR: '3' } });
  try {
    const bad = await t.req('POST', '/api/signup', { body: { business: 'x' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.errors.email);

    const bot = await t.req('POST', '/api/signup', { body: validSignup({ website: 'spam.example' }) });
    assert.equal(bot.status, 202);
    assert.equal(t.db.listClients().length, 0, 'honeypot submissions are dropped');

    assert.equal((await t.req('POST', '/api/signup', { body: validSignup() })).status, 202);
    assert.equal((await t.req('POST', '/api/signup', { body: validSignup() })).status, 409);
    assert.equal((await t.req('POST', '/api/signup', { body: validSignup({ email: 'b@x.example' }) })).status, 202);
    assert.equal((await t.req('POST', '/api/signup', { body: validSignup({ email: 'c@x.example' }) })).status, 503, 'capacity');
    assert.equal((await t.req('POST', '/api/signup', { body: validSignup({ email: 'd@x.example' }) })).status, 429, 'rate limit');
    await t.idle();
  } finally { await t.close(); }
});

test('admin endpoints require the token', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.req('GET', '/api/admin/clients')).status, 401);
    assert.equal((await t.req('GET', '/api/admin/clients', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await t.req('GET', '/api/admin/clients', { headers: auth })).status, 200);
  } finally { await t.close(); }
});

test('the website and health check are served', async () => {
  const t = await startApp();
  try {
    const home = await t.req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /id="signupForm"/);
    assert.equal((await t.req('GET', '/privacy')).status, 200);
    assert.deepEqual((await t.req('GET', '/healthz')).json, { ok: true });
  } finally { await t.close(); }
});
