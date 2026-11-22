import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET } from './helpers.js';
import { ownerKey } from '../src/owner.js';
import { runMonthlyResults, runQuoteFollowUps, monthResults, defaultCampaignText } from '../src/growth.js';
import { zonedToUtc } from '../src/scheduling.js';

const SMS = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15135550000' };
const DAY = 86_400_000;

async function liveShop(t, over = {}) {
  const r = await t.req('POST', '/api/signup', { body: validSignup(over) });
  await t.idle();
  return t.db.getClient(r.json.client.id);
}
const owner = (t, c) => `?key=${ownerKey(t.config, c.id)}`;
const hook = (t, id, message) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message } });
function texts(t) {
  const sent = [];
  t.app.locals.deps.syncFetch = async (url, opts) => {
    if (String(url).endsWith('/Messages.json')) { const f = new URLSearchParams(opts.body); sent.push({ to: f.get('To'), body: f.get('Body') }); }
    return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }) };
  };
  return sent;
}

// ---- Booking page
test('customers book online on the shop\'s own page, in the receptionist\'s open times', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    const dash = (await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`)).json;
    assert.equal(dash.bookingPage.url, 'https://desk.example.com/b/maple-row-heating-and-air');
    assert.equal((await t.req('GET', '/b/maple-row-heating-and-air')).status, 200);

    const page = (await t.req('GET', '/api/book/maple-row-heating-and-air')).json;
    assert.equal(page.business, 'Maple Row Heating & Air');
    assert.equal(page.needsAddress, true);
    assert.ok(page.slots.length > 0);
    assert.equal(page.phoneE164, c.phoneNumber);
    assert.equal(page.email, undefined, 'no private details on the public page');

    const bad = await t.req('POST', '/api/book/maple-row-heating-and-air', { body: { slot_start: page.slots[0].slot_start, name: '', phone: 'x' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.errors.name && bad.json.errors.phone && bad.json.errors.address && bad.json.errors.issue);

    const ok = await t.req('POST', '/api/book/maple-row-heating-and-air', { body: { slot_start: page.slots[0].slot_start, name: 'Laura Smith', phone: '513-555-0191', address: '412 Elm St', issue: 'AC tune-up' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.window, page.slots[0].label);
    await t.idle();
    const b = (await t.db.listBookings(c.id)).find((x) => x.kind === 'booking');
    assert.equal(b.caller_phone, '+15135550191');
    assert.match(b.issue, /booked online/);
    assert.ok(t.mailer.sent.some((m) => m.to === c.email && /Booked online/.test(m.text)));
    assert.ok(sent.some((s) => s.to === '+15135550191' && /you're booked/.test(s.body)));

    // That window is now full (one job per window by default).
    const again = await t.req('POST', '/api/book/maple-row-heating-and-air', { body: { slot_start: page.slots[0].slot_start, name: 'Ben', phone: '513-555-0192', address: '1 Main', issue: 'No heat' } });
    assert.equal(again.status, 409);
    assert.ok(Array.isArray(again.json.slots));
  } finally { await t.close(); }
});

test('the owner can turn the booking page off, and unknown pages are a plain 404', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`);
    assert.equal((await t.req('POST', `/api/owner/${c.id}/settings${owner(t, c)}`, { body: { onlineBooking: false } })).status, 200);
    assert.equal((await t.req('GET', '/api/book/maple-row-heating-and-air')).status, 404);
    assert.equal((await t.req('GET', '/api/book/nobody-here')).status, 404);
    const honeypot = await t.req('POST', '/api/book/nobody-here', { body: { website: 'spam' } });
    assert.equal(honeypot.status, 200, 'bots get a fake success');
  } finally { await t.close(); }
});

test('two shops with the same name get different booking pages', async () => {
  const t = await startApp();
  try {
    const a = await liveShop(t);
    const b = await liveShop(t, { email: 'b@x.example' });
    const ua = (await t.req('GET', `/api/owner/${a.id}${owner(t, a)}`)).json.bookingPage.url;
    const ub = (await t.req('GET', `/api/owner/${b.id}${owner(t, b)}`)).json.bookingPage.url;
    assert.notEqual(ua, ub);
    assert.match(ub, /maple-row-heating-and-air-2$/);
  } finally { await t.close(); }
});

// ---- Results
test('monthly results count calls, after-hours calls, bookings and their value', () => {
  const client = { details: { avgJob: 350, schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', timezone: 'America/New_York' } } };
  const at = (d, h) => zonedToUtc(2026, 11, d, h, 0, 'America/New_York').toISOString();
  const calls = [{ created_at: at(10, 10) }, { created_at: at(10, 22) }, { created_at: at(14, 11) }, { created_at: at(3, 23) }];
  const bookings = [{ kind: 'booking', created_at: at(10, 22) }, { kind: 'booking', created_at: at(12, 9) }, { kind: 'message', created_at: at(14, 11) }, { kind: 'booking', created_at: '2026-10-30T12:00:00Z' }];
  const r = monthResults(client, calls, bookings, { start: zonedToUtc(2026, 11, 1, 0, 0, 'America/New_York'), end: zonedToUtc(2026, 12, 1, 0, 0, 'America/New_York') });
  assert.deepEqual([r.calls, r.afterHours, r.booked, r.messages, r.value], [4, 3, 2, 1, 700]);
});

test('on the 1st, each shop gets last month\'s results once; the dashboard shows this month', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    await t.req('POST', `/api/owner/${c.id}/settings${owner(t, c)}`, { body: { avgJob: '$400' } });
    const lastMonth = new Date(Date.now() - 40 * DAY);
    await t.db.saveCall({ id: 'k1', clientId: c.id, callerPhone: '+15135550100', createdAt: lastMonth.toISOString(), durationS: 90 });
    await t.db.addBooking({ clientId: c.id, kind: 'booking', slotStart: lastMonth.toISOString(), callerName: 'A', capacity: 1 });
    // Bookings record "now" as created_at, so check results through the dashboard for this month.
    const view = (await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`)).json.results;
    assert.equal(view.thisMonth.booked, 1);
    assert.equal(view.thisMonth.value, 400);

    const first = new Date(zonedToUtc(2027, 1, 1, 9, 0, 'America/New_York'));
    const deps = { ...t.app.locals.deps, now: () => first };
    t.mailer.sent.length = 0;
    await t.db.saveCall({ id: 'k2', clientId: c.id, callerPhone: '+15135550101', createdAt: zonedToUtc(2026, 12, 15, 21, 0, 'America/New_York').toISOString(), durationS: 60 });
    assert.equal(await runMonthlyResults(deps), 1);
    assert.equal(await runMonthlyResults(deps), 0, 'once per month');
    assert.match(t.mailer.sent[0].subject, /^December 2026: 1 call answered/);
    assert.match(t.mailer.sent[0].text, /1 of them after hours/);
    const early = { ...deps, now: () => new Date(zonedToUtc(2027, 2, 1, 6, 0, 'America/New_York')) };
    assert.equal(await runMonthlyResults(early), 0, 'not before 8 AM');
  } finally { await t.close(); }
});

// ---- Quote follow-up and campaigns
test('three days after asking for a price without booking, the caller gets one follow-up text', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    await hook(t, c.id, { type: 'tool-calls', call: { id: 'q1' }, toolCallList: [{ id: 'a', function: { name: 'take_message', arguments: { name: 'Joe Park', phone: '513-555-0123', issue: 'Wants a quote for a new AC system', urgency: 'Routine' } } }] });
    await hook(t, c.id, { type: 'tool-calls', call: { id: 'q2' }, toolCallList: [{ id: 'b', function: { name: 'take_message', arguments: { name: 'Amy', phone: '513-555-0124', issue: 'Thermostat question', urgency: 'Routine' } } }] });
    await t.idle(); sent.length = 0;
    const deps = (days) => ({ ...t.app.locals.deps, now: () => new Date(Date.now() + days * DAY) });
    assert.equal(await runQuoteFollowUps(deps(1)), 0, 'too soon');
    assert.equal(await runQuoteFollowUps(deps(3.2)), 1);
    assert.equal(await runQuoteFollowUps(deps(3.5)), 0, 'once');
    assert.equal(sent[0].to, '+15135550123');
    assert.match(sent[0].body, /Hi Joe, it's Maple Row Heating & Air\. You asked about a price/);
    assert.match(sent[0].body, /Book online: https:\/\/desk\.example\.com\/b\//);
  } finally { await t.close(); }
});

test('a tune-up campaign texts each past customer once, with the booking link', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    for (const [n, p] of [['Ann Lee', '513-555-0131'], ['Ben Ray', '513-555-0132'], ['Ann Lee', '(513) 555-0131']]) {
      await t.db.addBooking({ clientId: c.id, kind: 'booking', slotStart: new Date(Date.now() - Math.random() * 90 * DAY).toISOString(), callerName: n, callerPhone: p, capacity: 5 });
    }
    const url = `/api/owner/${c.id}/campaign${owner(t, c)}`;
    const preview = (await t.req('GET', url)).json;
    assert.equal(preview.audience, 2, 'same customer counted once');
    assert.match(preview.text, /Reply STOP to opt out/);
    assert.match(preview.text, /\{name\}/);
    assert.equal((await t.req('POST', url, { body: { message: 'Hi {name}, book now please!!' } })).status, 400, 'must include STOP');
    const r = await t.req('POST', url, { body: { message: preview.text } });
    assert.equal(r.status, 200);
    await t.idle();
    assert.equal(sent.length, 2);
    assert.ok(sent.some((s) => s.to === '+15135550131' && /^Hi Ann, it's Maple Row/.test(s.body)));
    assert.equal((await t.req('GET', url)).json.audience, 0, 'nobody twice in 90 days');
    assert.equal((await t.req('POST', url, { body: { message: preview.text } })).status, 409);
  } finally { await t.close(); }
});

test('campaign text fits the trade and season', () => {
  const config = { publicUrl: 'https://d.example', brandName: 'X' };
  const shop = (trade, country = 'US') => ({ business: 'Pros', status: 'active', phoneNumber: '+15135550000', details: { trade, country, bookingSlug: 'pros', schedule: { timezone: 'America/New_York' } } });
  assert.match(defaultCampaignText(config, shop('hvac'), new Date('2026-04-10')), /AC tune-up/);
  assert.match(defaultCampaignText(config, shop('hvac'), new Date('2026-10-10')), /heating checked/);
  assert.match(defaultCampaignText(config, shop('plumbing')), /water heater/);
  assert.match(defaultCampaignText(config, shop('hvac')), /https:\/\/d\.example\/b\/pros/);
});

// ---- Recordings and lost links
test('call recordings are kept and shown on the dashboard', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    await hook(t, c.id, { type: 'end-of-call-report', call: { id: 'r1', customer: { number: '+15135550177' } }, durationSeconds: 80, artifact: { recordingUrl: 'https://storage.vapi.ai/r1.wav' } });
    const calls = (await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`)).json.calls;
    assert.equal(calls[0].recording, 'https://storage.vapi.ai/r1.wav');
  } finally { await t.close(); }
});

test('an owner who lost the link gets it by email, and the reply never reveals who has an account', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const known = await t.req('POST', '/api/find-dashboard', { body: { email: 'PAT@maplerow.example' } });
    const unknown = await t.req('POST', '/api/find-dashboard', { body: { email: 'nobody@else.example' } });
    assert.equal(known.status, 200);
    assert.deepEqual(known.json, unknown.json);
    await t.idle();
    const mail = t.mailer.sent.find((m) => /dashboard link/.test(m.subject));
    assert.equal(mail.to, 'pat@maplerow.example');
    assert.match(mail.text, new RegExp(`/my/${c.id}\\?key=`));
    assert.ok(!t.mailer.sent.some((m) => m.to === 'nobody@else.example'));
    assert.equal((await t.req('POST', '/api/find-dashboard', { body: { email: 'bad' } })).status, 400);
  } finally { await t.close(); }
});
