import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, validSignup, fakeVapi, SECRET, ADMIN } from './helpers.js';
import { normalizePhone, prettyPhone } from '../src/phone.js';
import { ownerKey } from '../src/owner.js';
import { peakFrom } from '../src/usage.js';

const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const indiaSignup = (over = {}) => validSignup({
  country: 'IN', business: 'CoolBreeze AC Services', email: 'ravi@coolbreeze.example', phone: '98765 43210',
  area: 'Andheri, Bandra, Powai', timezone: '', oncall: '91234 56789', office: '', gasline: '', fee: '₹299 visit charge', ...over,
});

test('phone numbers: US and Indian formats in, international out', () => {
  assert.equal(normalizePhone('(513) 555-0142'), '+15135550142');
  assert.equal(normalizePhone('98765 43210', 'IN'), '+919876543210');
  assert.equal(normalizePhone('098765 43210', 'IN'), '+919876543210');
  assert.equal(normalizePhone('022 2345 6789', 'IN'), '+912223456789');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('12345', 'IN'), '');
  assert.equal(prettyPhone('+919876543210'), '+91 98765 43210');
  assert.equal(prettyPhone('+15135550142'), '(513) 555-0142');
});

test('an Indian shop gets an AC-service script in Hindi and English, Indian safety numbers, and waits for a +91 number', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: indiaSignup() });
    assert.equal(r.status, 202);
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.equal(c.phone, '+919876543210');
    assert.equal(c.details.country, 'IN');
    assert.equal(c.details.schedule.timezone, 'Asia/Kolkata');
    assert.equal(c.details.areaCode, '');
    assert.equal(c.status, 'needs_number');
    assert.ok(!t.vapi.calls.some(([n]) => n === 'createPhoneNumber'), 'no Vapi number is bought for India');

    const [, body] = t.vapi.calls.find(([n]) => n === 'createAssistant');
    assert.match(body.firstMessage, /^Namaste! Thanks for calling CoolBreeze AC Services/);
    assert.match(body.firstMessage, /Calls are recorded/);
    assert.deepEqual(body.transcriber, { provider: 'deepgram', model: 'nova-3', language: 'multi' });
    const prompt = body.model.messages[0].content;
    assert.match(prompt, /an air conditioning service company/);
    assert.match(prompt, /call 112, or 1906 for an LPG gas leak/);
    assert.doesNotMatch(prompt, /911/);
    assert.match(prompt, /Callers may speak Hindi, English or a mix/);
    assert.match(prompt, /mera AC cooling nahi kar raha/);
    assert.match(prompt, /annual maintenance contracts/);
    assert.ok(t.mailer.sent.some((m) => /Attach a number: CoolBreeze/.test(m.subject)));
  } finally { await t.close(); }
});

test('a piped-gas company number replaces the LPG helpline in the safety line', async () => {
  const t = await startApp();
  try {
    await t.req('POST', '/api/signup', { body: indiaSignup({ gasline: '022 6156 4444' }) });
    await t.idle();
    const [, body] = t.vapi.calls.find(([n]) => n === 'createAssistant');
    assert.match(body.model.messages[0].content, /call 112, or the gas company on 22615 64444, from outside/);
  } finally { await t.close(); }
});

test('the operator attaches a +91 number from the Indian provider, and the owner gets the welcome email', async () => {
  const t = await startApp({ env: { VAPI_IN_SIP_CREDENTIAL_ID: 'cred_in_1' } });
  try {
    const r = await t.req('POST', '/api/signup', { body: indiaSignup() });
    await t.idle();
    const id = r.json.client.id;
    assert.equal((await t.req('POST', `/api/admin/clients/${id}/attach-number`, { ...auth, body: { number: '12345' } })).status, 400);
    const ok = await t.req('POST', `/api/admin/clients/${id}/attach-number`, { ...auth, body: { number: '022 4000 1234' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.client.status, 'active');
    const [, phone] = t.vapi.calls.find(([n]) => n === 'createPhoneNumber');
    assert.equal(phone.provider, 'byo-phone-number');
    assert.equal(phone.number, '+912240001234');
    assert.equal(phone.credentialId, 'cred_in_1');
    assert.equal(phone.numberE164CheckEnabled, false);
    assert.equal(phone.fallbackDestination.number, '+919123456789');
    const welcome = t.mailer.sent.find((m) => m.to === 'ravi@coolbreeze.example' && /is live/.test(m.subject));
    assert.match(welcome.html, /\+91 22 4000 1234/);
    assert.equal((await t.req('POST', `/api/admin/clients/${id}/attach-number`, { ...auth, body: { number: '022 4000 1235' } })).status, 409, 'only once');
  } finally { await t.close(); }
});

test('attaching needs the Indian SIP credential to be set', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: indiaSignup() }); await t.idle();
    const res = await t.req('POST', `/api/admin/clients/${r.json.client.id}/attach-number`, { ...auth, body: { number: '+912240001234' } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /VAPI_IN_SIP_CREDENTIAL_ID/);
  } finally { await t.close(); }
});

function twilioFake({ failImport = false } = {}) {
  const log = [];
  const vapi = fakeVapi();
  const base = vapi.createPhoneNumber.bind(vapi);
  vapi.createPhoneNumber = async (body) => {
    vapi.calls.push(['createPhoneNumber', body]);
    if (body.provider === 'vapi') throw new Error('Vapi POST /phone-number failed (400): You can only have 10 free numbers.');
    if (failImport) throw new Error('Vapi POST /phone-number failed (400): bad twilio credentials');
    return { id: 'pn_tw', number: body.number };
  };
  void base;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, query: u.search, method: opts.method || 'GET', body: opts.body, auth: opts.headers?.Authorization });
    if (u.pathname.endsWith('/AvailablePhoneNumbers/US/Local.json')) return reply(200, { available_phone_numbers: u.searchParams.get('AreaCode') === '513' ? [{ phone_number: '+15135550777' }] : [] });
    if (u.pathname.endsWith('/IncomingPhoneNumbers.json')) return reply(201, { sid: 'PN123', phone_number: new URLSearchParams(opts.body).get('PhoneNumber') });
    if (u.pathname.endsWith('/IncomingPhoneNumbers/PN123.json')) return { ok: true, status: 204, json: async () => ({}) };
    return reply(404, { message: 'no fake' });
  };
  return { vapi, fetchImpl, log };
}

test('past Vapi\'s 10 free numbers, a local Twilio number is bought and imported into Vapi', async () => {
  const f = twilioFake();
  const t = await startApp({ vapi: f.vapi, env: { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw_secret' } });
  try {
    t.app.locals.deps.syncFetch = f.fetchImpl;
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.equal(c.status, 'active');
    assert.equal(c.phoneNumber, '+15135550777');
    assert.equal(c.details.twilioNumberSid, 'PN123');
    assert.match(f.log[0].query, /AreaCode=513/);
    assert.equal(f.log[0].auth, `Basic ${Buffer.from('AC123:tw_secret').toString('base64')}`);
    const imp = f.vapi.calls.filter(([n]) => n === 'createPhoneNumber').map(([, b]) => b).find((b) => b.provider === 'twilio');
    assert.deepEqual([imp.number, imp.twilioAccountSid, imp.twilioAuthToken, imp.assistantId], ['+15135550777', 'AC123', 'tw_secret', c.vapiAssistantId]);
  } finally { await t.close(); }
});

test('if Vapi refuses the Twilio number, it is released so it costs nothing', async () => {
  const f = twilioFake({ failImport: true });
  const t = await startApp({ vapi: f.vapi, env: { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw_secret' } });
  try {
    t.app.locals.deps.syncFetch = f.fetchImpl;
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    assert.equal((await t.db.getClient(r.json.client.id)).status, 'failed');
    assert.ok(f.log.some((l) => l.method === 'DELETE' && l.path.endsWith('/IncomingPhoneNumbers/PN123.json')));
  } finally { await t.close(); }
});

const stripeSig = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('US shops subscribe through Stripe Checkout, and Stripe webhooks update the shop', async () => {
  const sent = [];
  const t = await startApp({ env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_PRICE_ID: 'price_199', STRIPE_WEBHOOK_SECRET: 'whsec_1' } });
  try {
    t.app.locals.deps.syncFetch = async (url, opts) => { sent.push({ url, opts }); return reply(200, { url: 'https://checkout.stripe.com/c/pay/cs_1' }); };
    const r = await t.req('POST', '/api/signup', { body: validSignup() }); await t.idle();
    const id = r.json.client.id, key = ownerKey(t.config, id);
    assert.deepEqual((await t.req('GET', `/api/owner/${id}?key=${key}`)).json.billing, { provider: 'stripe', status: null });

    const co = await t.req('POST', `/api/owner/${id}/billing/checkout?key=${key}`);
    assert.equal(co.json.url, 'https://checkout.stripe.com/c/pay/cs_1');
    const form = new URLSearchParams(sent[0].opts.body);
    assert.equal(sent[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(form.get('line_items[0][price]'), 'price_199');
    assert.equal(form.get('client_reference_id'), id);
    assert.equal(form.get('subscription_data[trial_period_days]'), '14');
    assert.equal(sent[0].opts.headers.Authorization, 'Bearer sk_test_1');

    const event = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due', metadata: { client_id: id } } } });
    const bad = await t.req('POST', '/api/billing/stripe/webhook', { body: JSON.parse(event), headers: { 'stripe-signature': 't=1,v1=bad' } });
    assert.equal(bad.status, 400);
    const ok = await t.req('POST', '/api/billing/stripe/webhook', { body: JSON.parse(event), headers: { 'stripe-signature': stripeSig('whsec_1', event) } });
    assert.equal(ok.status, 200);
    const c = await t.db.getClient(id);
    assert.deepEqual([c.details.billing.status, c.details.billing.subscriptionId, c.details.billing.provider], ['past_due', 'sub_1', 'stripe']);
    assert.ok(t.mailer.sent.some((m) => /Billing: Maple Row Heating & Air is past due/.test(m.subject)));
  } finally { await t.close(); }
});

test('Indian shops subscribe through Razorpay, and Razorpay webhooks update the shop', async () => {
  const t = await startApp({ env: { RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'rzp_secret', RAZORPAY_PLAN_ID: 'plan_in_1', RAZORPAY_WEBHOOK_SECRET: 'rzp_wh' } });
  const sent = [];
  try {
    t.app.locals.deps.syncFetch = async (url, opts) => { sent.push({ url, opts }); return reply(200, { id: 'sub_rzp_1', short_url: 'https://rzp.io/i/abc' }); };
    const r = await t.req('POST', '/api/signup', { body: indiaSignup() }); await t.idle();
    const id = r.json.client.id, key = ownerKey(t.config, id);
    const co = await t.req('POST', `/api/owner/${id}/billing/checkout?key=${key}`);
    assert.equal(co.json.url, 'https://rzp.io/i/abc');
    const body = JSON.parse(sent[0].opts.body);
    assert.equal(body.plan_id, 'plan_in_1');
    assert.equal(body.notes.client_id, id);

    const event = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_rzp_1', customer_id: 'cust_9', notes: { client_id: id } } } } });
    const sig = createHmac('sha256', 'rzp_wh').update(event).digest('hex');
    assert.equal((await t.req('POST', '/api/billing/razorpay/webhook', { body: JSON.parse(event), headers: { 'x-razorpay-signature': 'nope' } })).status, 400);
    assert.equal((await t.req('POST', '/api/billing/razorpay/webhook', { body: JSON.parse(event), headers: { 'x-razorpay-signature': sig } })).status, 200);
    assert.equal((await t.db.getClient(id)).details.billing.status, 'active');
  } finally { await t.close(); }
});

test('without payment keys, the owner is told an invoice will come instead', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() }); await t.idle();
    const id = r.json.client.id;
    const co = await t.req('POST', `/api/owner/${id}/billing/checkout?key=${ownerKey(t.config, id)}`);
    assert.equal(co.status, 501);
  } finally { await t.close(); }
});

test('support staff sign in with their own token; short tokens are ignored', async () => {
  const t = await startApp({ env: { SUPPORT_TOKENS: 'Priya:support-token-priya-0123456789ab,Sam:short' } });
  try {
    const me = await t.req('GET', '/api/admin/me', { headers: { Authorization: 'Bearer support-token-priya-0123456789ab' } });
    assert.deepEqual([me.status, me.json.name], [200, 'Priya']);
    assert.equal((await t.req('GET', '/api/admin/clients', { headers: { Authorization: 'Bearer short' } })).status, 401);
    assert.equal((await t.req('GET', '/api/admin/me', auth)).json.name, 'owner');
  } finally { await t.close(); }
});

test('missed reports for every shop are fetched with one paged request, not one per shop', async () => {
  const t = await startApp();
  try {
    await t.req('POST', '/api/signup', { body: validSignup() });
    await t.req('POST', '/api/signup', { body: validSignup({ email: 'b@b.example', business: 'Shop Two' }) });
    await t.idle();
    t.vapi.calls.length = 0;
    await t.req('POST', '/api/admin/recover-calls', auth);
    const lists = t.vapi.calls.filter(([n]) => n === 'listCalls');
    assert.equal(lists.length, 1);
    assert.equal(lists[0][1].assistantId, undefined);
  } finally { await t.close(); }
});

test('busiest moment counts calls that overlap, across shops, and warns at 80% of the lines', async () => {
  assert.equal(peakFrom([
    { started_at: '2026-11-07T10:00:00Z', duration_s: 300 },
    { started_at: '2026-11-07T10:02:00Z', duration_s: 300 },
    { started_at: '2026-11-07T10:05:00Z', duration_s: 60 },
    { started_at: '2026-11-07T11:00:00Z', duration_s: 60 },
  ]), 2, 'a call ending as another starts does not overlap it');

  const t = await startApp({ env: { VAPI_CONCURRENCY: '3' } });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() }); await t.idle();
    const id = r.json.client.id;
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    for (const n of [1, 2, 3]) {
      await t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message: { type: 'end-of-call-report', call: { id: `cc${n}` }, startedAt, durationSeconds: 100, analysis: { summary: 'x' } } } });
    }
    await new Promise((res) => setTimeout(res, 50));
    const alerts = t.mailer.sent.filter((m) => /Phone lines:/.test(m.subject));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].subject, /3 of 3 in use at once|2 of 3 in use at once/);
    assert.equal((await t.req('GET', '/api/admin/overview', auth)).json.busiestToday, 3);
  } finally { await t.close(); }
});
