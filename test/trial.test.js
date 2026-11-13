import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, validSignup, ADMIN } from './helpers.js';
import { runTrials } from '../src/trial.js';
import { ownerKey } from '../src/owner.js';

const DAY = 86_400_000;
const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };
const STRIPE = { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_PRICE_ID: 'price_199', STRIPE_WEBHOOK_SECRET: 'whsec_1' };
const stripeSig = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_1').update(`${t}.${body}`).digest('hex')}`;

async function liveShop(t) {
  const r = await t.req('POST', '/api/signup', { body: validSignup() });
  await t.idle();
  return t.db.getClient(r.json.client.id);
}
const run = (t, at) => runTrials({ ...t.app.locals.deps, now: () => at });
const subjects = (t) => t.mailer.sent.map((m) => m.subject);

test('the free month starts when the receptionist goes live, and the welcome email says so', async () => {
  const t = await startApp();
  try {
    const before = Date.now();
    const c = await liveShop(t);
    assert.equal(c.status, 'active');
    const ends = new Date(c.details.trial.endsAt).getTime();
    assert.ok(Math.abs(ends - (before + 30 * DAY)) < 60_000, 'ends 30 days after going live');
    const welcome = t.mailer.sent.find((m) => /receptionist is live/.test(m.subject));
    assert.match(welcome.text, /Your first month is free, until/);
    assert.match(welcome.html, /first month is free/);
  } finally { await t.close(); }
});

test('reminders at 7 days, 2 days and the end, each sent once; then paused after the grace days', async () => {
  const t = await startApp({ env: STRIPE });
  try {
    const c = await liveShop(t);
    const end = new Date(c.details.trial.endsAt).getTime();
    t.mailer.sent.length = 0;

    await run(t, new Date(end - 10 * DAY));
    assert.equal(t.mailer.sent.length, 0, 'nothing with 10 days left');
    await run(t, new Date(end - 6 * DAY));
    await run(t, new Date(end - 6 * DAY + 3600_000));
    assert.deepEqual(subjects(t), ['7 days left in your free month']);
    await run(t, new Date(end - 1 * DAY));
    await run(t, new Date(end + 3600_000));
    assert.deepEqual(subjects(t).slice(1), ['Your free month ends in 2 days', 'Your free month has ended']);
    assert.match(t.mailer.sent[1].text, /won't be charged until/);
    assert.match(t.mailer.sent[2].text, new RegExp(`/my/${c.id}\\?key=`), 'every reminder links to the dashboard');
    assert.equal((await t.db.getClient(c.id)).status, 'active', 'still answering during the grace days');

    await run(t, new Date(end + 3 * DAY + 3600_000));
    const p = await t.db.getClient(c.id);
    assert.equal(p.status, 'paused');
    assert.equal(p.details.pausedFor, 'trial');
    assert.deepEqual(t.vapi.calls.find(([n, , b]) => n === 'updatePhoneNumber' && b.assistantId === null).slice(1), [p.vapiPhoneId, { assistantId: null }]);
    assert.ok(subjects(t).includes('Your receptionist is paused'));
    assert.ok(t.mailer.sent.some((m) => /Paused for payment/.test(m.subject)), 'the operator hears too');
  } finally { await t.close(); }
});

test('paying during the free month means no reminders and no pause', async () => {
  const t = await startApp({ env: STRIPE });
  try {
    const c = await liveShop(t);
    const end = new Date(c.details.trial.endsAt).getTime();
    const event = JSON.stringify({ type: 'customer.subscription.created', data: { object: { id: 'sub_1', status: 'trialing', customer: 'cus_1', metadata: { client_id: c.id } } } });
    assert.equal((await t.req('POST', '/api/billing/stripe/webhook', { body: JSON.parse(event), headers: { 'stripe-signature': stripeSig(event) } })).status, 200);
    t.mailer.sent.length = 0;
    await run(t, new Date(end - 1 * DAY));
    await run(t, new Date(end + 10 * DAY));
    assert.equal(t.mailer.sent.length, 0);
    assert.equal((await t.db.getClient(c.id)).status, 'active');
  } finally { await t.close(); }
});

test('paying after the pause turns the receptionist straight back on', async () => {
  const t = await startApp({ env: STRIPE });
  try {
    const c = await liveShop(t);
    await run(t, new Date(new Date(c.details.trial.endsAt).getTime() + 4 * DAY));
    assert.equal((await t.db.getClient(c.id)).status, 'paused');
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: c.id, subscription: 'sub_1', customer: 'cus_1' } } });
    await t.req('POST', '/api/billing/stripe/webhook', { body: JSON.parse(event), headers: { 'stripe-signature': stripeSig(event) } });
    const back = await t.db.getClient(c.id);
    assert.equal(back.status, 'active');
    assert.equal(back.details.pausedFor, undefined);
    assert.ok(t.vapi.calls.some(([n, id, b]) => n === 'updatePhoneNumber' && id === back.vapiPhoneId && b.assistantId === back.vapiAssistantId));
    assert.ok(subjects(t).includes('Your receptionist is answering again'));
  } finally { await t.close(); }
});

test('without online payment for the shop, nothing is paused: the operator is told to invoice', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    await run(t, new Date(new Date(c.details.trial.endsAt).getTime() + 5 * DAY));
    assert.equal((await t.db.getClient(c.id)).status, 'active');
    assert.ok(t.mailer.sent.some((m) => /Free month over: /.test(m.subject) && /send an invoice/.test(m.text)));
  } finally { await t.close(); }
});

test('the operator can extend the free month, mark a shop paid, and pause or resume by hand', async () => {
  const t = await startApp({ env: STRIPE });
  try {
    const c = await liveShop(t);
    const end = new Date(c.details.trial.endsAt).getTime();
    await run(t, new Date(end + 4 * DAY));
    assert.equal((await t.db.getClient(c.id)).status, 'paused');

    const ext = await t.req('POST', `/api/admin/clients/${c.id}/extend-trial`, { ...auth, body: { days: 14 } });
    assert.equal(ext.status, 200);
    assert.equal(ext.json.client.status, 'active', 'extending turns it back on');
    assert.ok(ext.json.client.trial.daysLeft >= 13);

    const paid = await t.req('POST', `/api/admin/clients/${c.id}/mark-paid`, { ...auth, body: { paid: true } });
    assert.equal(paid.json.client.trial.paid, true);
    const key = ownerKey(t.config, c.id);
    assert.equal((await t.req('GET', `/api/owner/${c.id}?key=${key}`)).json.billing.status, 'active');

    assert.equal((await t.req('POST', `/api/admin/clients/${c.id}/pause`, auth)).json.client.status, 'paused');
    await run(t, new Date(end + 60 * DAY));
    assert.equal((await t.db.getClient(c.id)).status, 'paused', 'a pause by the operator is never undone automatically');
    assert.equal((await t.req('POST', `/api/admin/clients/${c.id}/resume`, auth)).json.client.status, 'active');
  } finally { await t.close(); }
});

test('the owner dashboard shows days left, and shops live before trials get their month from now', async () => {
  const t = await startApp({ env: STRIPE });
  try {
    let c = await liveShop(t);
    const key = ownerKey(t.config, c.id);
    const view = (await t.req('GET', `/api/owner/${c.id}?key=${key}`)).json;
    assert.equal(view.trial.daysLeft, 30);
    assert.equal(view.trial.ended, false);

    const { trial, ...details } = c.details;
    await t.db.updateClient(c.id, { details });
    const now = new Date();
    await run(t, now);
    c = await t.db.getClient(c.id);
    assert.ok(Math.abs(new Date(c.details.trial.endsAt).getTime() - (now.getTime() + 30 * DAY)) < 1000);
  } finally { await t.close(); }
});

test('TRIAL_DAYS=0 turns the free month off', async () => {
  const t = await startApp({ env: { TRIAL_DAYS: '0' } });
  try {
    const c = await liveShop(t);
    assert.equal(c.details.trial, undefined);
  } finally { await t.close(); }
});
