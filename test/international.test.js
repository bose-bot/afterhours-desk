import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, ADMIN } from './helpers.js';
import { normalizePhone, prettyPhone } from '../src/phone.js';
import { COUNTRY_CODES } from '../src/countries.js';

const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };
const TW = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw_secret' };
const SHOPS = {
  CA: { business: 'Northern Comfort HVAC', phone: '(416) 555-0142', oncall: '(416) 555-0199', timezone: 'America/Toronto' },
  GB: { business: 'Thames Boiler Co', phone: '07700 900123', oncall: '07700 900456', timezone: '' },
  AU: { business: 'Harbour Air Con', phone: '0412 345 678', oncall: '0412 345 999', timezone: 'Australia/Sydney' },
  AE: { business: 'Gulf Cool Technical Services', phone: '050 123 4567', oncall: '050 765 4321', timezone: '' },
  SA: { business: 'Riyadh Breeze AC', phone: '050 123 4567', oncall: '055 765 4321', timezone: '', workDays: 'sun-thu' },
};
const signup = (cc, over = {}) => validSignup({ country: cc, office: '', gasline: '', email: `owner@${cc.toLowerCase()}.example`, ...SHOPS[cc], ...over });
const prompt = (t) => t.vapi.calls.find(([n]) => n === 'createAssistant')[1].model.messages[0].content;
const assistant = (t) => t.vapi.calls.find(([n]) => n === 'createAssistant')[1];

// A fake Twilio that records each search and purchase.
function twilio() {
  const log = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, query: u.search, body: String(opts.body || '') });
    const json = async () => (u.pathname.includes('AvailablePhoneNumbers')
      ? { available_phone_numbers: [{ phone_number: u.pathname.includes('/GB/') ? '+442079460958' : '+14165550777' }] }
      : { sid: 'PN9', phone_number: u.pathname.includes('IncomingPhoneNumbers') ? undefined : '' });
    return { ok: true, status: 200, json };
  };
  return { log, fetchImpl };
}

test('the registry covers seven countries', () => {
  assert.deepEqual([...COUNTRY_CODES].sort(), ['AE', 'AU', 'CA', 'GB', 'IN', 'SA', 'US']);
});

test('phone numbers from every country are read in local format and stored internationally', () => {
  assert.equal(normalizePhone('(416) 555-0142', 'CA'), '+14165550142');
  assert.equal(normalizePhone('020 7946 0958', 'GB'), '+442079460958');
  assert.equal(normalizePhone('0412 345 678', 'AU'), '+61412345678');
  assert.equal(normalizePhone('050 123 4567', 'AE'), '+971501234567');
  assert.equal(normalizePhone('050 123 4567', 'SA'), '+966501234567');
  assert.equal(prettyPhone('+442079460958'), '+44 20 7946 0958');
  assert.equal(prettyPhone('+61412345678'), '+61 412 345 678');
});

for (const [cc, check] of Object.entries({
  CA: (p, a) => { assert.match(p, /call 911 or your gas utility's emergency line from outside/); assert.match(a.firstMessage, /^Thanks for calling Northern Comfort HVAC/); },
  GB: (p, a) => { assert.match(p, /0800 111 999/); assert.match(p, /999 if anyone feels unwell/); assert.doesNotMatch(p, /911/); assert.match(a.firstMessage, /^Thanks for calling Thames Boiler Co/); },
  AU: (p) => { assert.match(p, /call 000 from outside/); assert.doesNotMatch(p, /911/); },
  AE: (p, a) => { assert.match(p, /Civil Defence on 997/); assert.match(p, /998 if anyone feels unwell/); assert.match(a.firstMessage, /^Marhaba! Thanks for calling Gulf Cool/); },
  SA: (p) => { assert.match(p, /call 911, or Civil Defence on 998/); },
})) {
  test(`${cc}: the script uses local safety numbers, greeting and the shop's details`, async () => {
    const t = await startApp();
    try {
      const r = await t.req('POST', '/api/signup', { body: signup(cc) });
      assert.equal(r.status, 202, JSON.stringify(r.json));
      await t.idle();
      const c = await t.db.getClient(r.json.client.id);
      assert.equal(c.details.country, cc);
      assert.ok(c.phone.startsWith('+'));
      check(prompt(t), assistant(t));
      assert.match(prompt(t), new RegExp(SHOPS[cc].business));
    } finally { await t.close(); }
  });
}

test('a Saudi shop works Sunday to Thursday, in Saudi time, with Arabic speech recognition', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: signup('SA') });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.deepEqual(c.details.schedule.days, [0, 1, 2, 3, 4]);
    assert.equal(c.details.schedule.timezone, 'Asia/Riyadh');
    assert.equal(c.details.language, 'ar');
    assert.deepEqual(assistant(t).transcriber, { provider: 'deepgram', model: 'nova-3', language: 'ar-SA' });
    assert.equal(c.status, 'needs_number', 'Saudi numbers come from a licensed provider');
    assert.ok(t.mailer.sent.some((m) => /Attach a number: Riyadh Breeze AC \(Saudi Arabia\)/.test(m.subject)));
  } finally { await t.close(); }
});

test('a UAE shop can pick Arabic or English, and a language voice is used when set', async () => {
  const t = await startApp({ env: { VAPI_VOICE_AR_PROVIDER: 'azure', VAPI_VOICE_AR_ID: 'ar-AE-FatimaNeural' } });
  try {
    await t.req('POST', '/api/signup', { body: signup('AE', { language: 'ar' }) });
    await t.idle();
    assert.deepEqual(assistant(t).transcriber, { provider: 'deepgram', model: 'nova-3', language: 'ar-AE' });
    assert.deepEqual(assistant(t).voice, { provider: 'azure', voiceId: 'ar-AE-FatimaNeural' });
  } finally { await t.close(); }
  const e = await startApp();
  try {
    await e.req('POST', '/api/signup', { body: signup('AE', { language: 'en' }) });
    await e.idle();
    assert.deepEqual(assistant(e).transcriber, { provider: 'deepgram', model: 'nova-3', language: 'en' });
  } finally { await e.close(); }
});

test('a US time zone is refused for a Canadian shop and replaced by the default', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: signup('CA', { timezone: 'America/Chicago' }) });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.ok(c.details.schedule.timezone.startsWith('America/'));
    assert.notEqual(c.details.schedule.timezone, 'America/Chicago');
  } finally { await t.close(); }
});

test('Canada: a local Twilio number is bought in the area code and imported into Vapi', async () => {
  const f = twilio();
  const t = await startApp({ env: TW });
  try {
    t.app.locals.deps.syncFetch = f.fetchImpl;
    const r = await t.req('POST', '/api/signup', { body: signup('CA') });
    await t.idle();
    const c = await t.db.getClient(r.json.client.id);
    assert.equal(c.status, 'active');
    assert.match(f.log[0].path, /AvailablePhoneNumbers\/CA\/Local\.json/);
    assert.match(f.log[0].query, /AreaCode=416/);
    const imp = t.vapi.calls.filter(([n]) => n === 'createPhoneNumber').map(([, b]) => b).find((b) => b.provider === 'twilio');
    assert.equal(imp.number, '+14165550777');
  } finally { await t.close(); }
});

test('UK: without an approved regulatory bundle the shop waits for a number; with one, Twilio buys it', async () => {
  const t = await startApp({ env: TW });
  try {
    const r = await t.req('POST', '/api/signup', { body: signup('GB') });
    await t.idle();
    assert.equal((await t.db.getClient(r.json.client.id)).status, 'needs_number');
    assert.ok(t.mailer.sent.some((m) => /TWILIO_BUNDLE_SID_GB/.test(m.text)));
  } finally { await t.close(); }

  const f = twilio();
  const b = await startApp({ env: { ...TW, TWILIO_BUNDLE_SID_GB: 'BU123', TWILIO_ADDRESS_SID_GB: 'AD456' } });
  try {
    b.app.locals.deps.syncFetch = f.fetchImpl;
    const r = await b.req('POST', '/api/signup', { body: signup('GB') });
    await b.idle();
    assert.equal((await b.db.getClient(r.json.client.id)).status, 'active');
    assert.match(f.log[0].path, /AvailablePhoneNumbers\/GB\/Local\.json/);
    const buy = f.log.find((l) => l.path.endsWith('IncomingPhoneNumbers.json'));
    assert.match(buy.body, /BundleSid=BU123/);
    assert.match(buy.body, /AddressSid=AD456/);
  } finally { await b.close(); }
});

test('UAE: the operator attaches a number through the local SIP provider', async () => {
  const t = await startApp({ env: { VAPI_SIP_CREDENTIAL_AE: 'cred_ae_1' } });
  try {
    const r = await t.req('POST', '/api/signup', { body: signup('AE') });
    await t.idle();
    const id = r.json.client.id;
    assert.equal((await t.db.getClient(id)).status, 'needs_number');
    const wrong = await t.req('POST', `/api/admin/clients/${id}/attach-number`, { ...auth, body: { number: '+919876543210' } });
    assert.equal(wrong.status, 400, 'an Indian number is refused for a UAE shop');
    const ok = await t.req('POST', `/api/admin/clients/${id}/attach-number`, { ...auth, body: { number: '04 123 4567' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.client.status, 'active');
    const [, phone] = t.vapi.calls.find(([n]) => n === 'createPhoneNumber');
    assert.deepEqual([phone.provider, phone.number, phone.credentialId], ['byo-phone-number', '+97141234567', 'cred_ae_1']);
  } finally { await t.close(); }
});

test('Australia: a number bought by hand in Twilio can be attached before the bundle is approved', async () => {
  const t = await startApp({ env: TW });
  try {
    const r = await t.req('POST', '/api/signup', { body: signup('AU') });
    await t.idle();
    const ok = await t.req('POST', `/api/admin/clients/${r.json.client.id}/attach-number`, { ...auth, body: { number: '02 9876 5432' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const [, phone] = t.vapi.calls.find(([n]) => n === 'createPhoneNumber');
    assert.deepEqual([phone.provider, phone.number], ['twilio', '+61298765432']);
  } finally { await t.close(); }
});

test('Stripe uses a country price when one is set', async () => {
  const t = await startApp({ env: { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_PRICE_ID: 'price_usd', STRIPE_PRICE_ID_GB: 'price_gbp' } });
  try {
    const sent = [];
    t.app.locals.deps.syncFetch = async (url, opts) => { sent.push(String(opts.body)); return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }) }; };
    const r = await t.req('POST', '/api/signup', { body: signup('GB') });
    await t.idle();
    const { ownerKey } = await import('../src/owner.js');
    const id = r.json.client.id;
    const res = await t.req('POST', `/api/owner/${id}/billing/checkout?key=${ownerKey(t.config, id)}`);
    assert.ok(res.status < 400, JSON.stringify(res.json));
    assert.ok(sent.some((b) => /price_gbp/.test(decodeURIComponent(b))));
  } finally { await t.close(); }
});
