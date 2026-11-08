import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET, ADMIN } from './helpers.js';
import { ownerKey, ownerUrl } from '../src/owner.js';
import { runMorningReports } from '../src/report.js';
import { zonedToUtc, zonedParts } from '../src/scheduling.js';
import { morningReportEmail } from '../src/emails.js';

const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };

async function liveShop(t, over = {}) {
  const r = await t.req('POST', '/api/signup', { body: validSignup(over) });
  await t.idle();
  return t.db.getClient(r.json.client.id);
}
const hook = (t, id, message) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message } });
async function overnightCall(t, id, callId) {
  await hook(t, id, { type: 'tool-calls', call: { id: callId, customer: { number: '+15135550177' } }, toolCallList: [
    { id: 'tc1', function: { name: 'take_message', arguments: { name: 'Dana Ruiz', phone: '+15135550177', issue: 'No heat, two kids at home', urgency: 'Priority' } } },
  ] });
  await hook(t, id, { type: 'end-of-call-report', call: { id: callId, customer: { number: '+15135550177' } }, durationSeconds: 95, analysis: { summary: 'No heat; wants a callback first thing.' } });
}
// The next 7:05 AM in the shop's time zone that is still less than a day away.
function next705(tz = 'America/New_York') {
  const p = zonedParts(new Date(), tz);
  let at = zonedToUtc(p.y, p.m, p.d, 7, 5, tz);
  if (at <= new Date()) at = new Date(at.getTime() + 86_400_000);
  return at;
}

test('the owner dashboard opens only with that shop\'s key', async () => {
  const t = await startApp();
  try {
    const a = await liveShop(t);
    const b = await liveShop(t, { email: 'b@shop.example', business: 'Queen City Comfort' });
    const page = await t.req('GET', `/my/${a.id}?key=${ownerKey(t.config, a.id)}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Your dashboard/);

    assert.equal((await t.req('GET', `/api/owner/${a.id}?key=${ownerKey(t.config, a.id)}`)).status, 200);
    assert.equal((await t.req('GET', `/api/owner/${a.id}`)).status, 404, 'no key');
    assert.equal((await t.req('GET', `/api/owner/${a.id}?key=nope`)).status, 404, 'wrong key');
    assert.equal((await t.req('GET', `/api/owner/${a.id}?key=${ownerKey(t.config, b.id)}`)).status, 404, "another shop's key");
    assert.match(ownerUrl(t.config, a), new RegExp(`^https://desk\\.example\\.com/my/${a.id}\\?key=`));
  } finally { await t.close(); }
});

test('the dashboard shows calls and callbacks, and the owner can mark them done and undo', async () => {
  const t = await startApp();
  try {
    const shop = await liveShop(t);
    const other = await liveShop(t, { email: 'b@shop.example', business: 'Queen City Comfort' });
    await overnightCall(t, shop.id, 'call_1');
    const key = ownerKey(t.config, shop.id);
    const { json } = await t.req('GET', `/api/owner/${shop.id}?key=${key}`);
    assert.equal(json.shop.business, 'Maple Row Heating & Air');
    assert.equal(json.calls.length, 1);
    assert.equal(json.calls[0].summary, 'No heat; wants a callback first thing.');
    assert.equal(json.calls[0].duration_s, 95);
    assert.equal(json.usage.minutes, 2);
    const msg = json.items.find((i) => i.kind === 'message');
    assert.equal(msg.urgency, 'Priority');
    assert.equal(msg.done_at, null);

    assert.equal((await t.req('POST', `/api/owner/${shop.id}/items/${msg.id}?key=${key}`, { body: { done: true } })).status, 200);
    assert.ok((await t.req('GET', `/api/owner/${shop.id}?key=${key}`)).json.items.find((i) => i.id === msg.id).done_at);
    await t.req('POST', `/api/owner/${shop.id}/items/${msg.id}?key=${key}`, { body: { done: false } });
    assert.equal((await t.req('GET', `/api/owner/${shop.id}?key=${key}`)).json.items.find((i) => i.id === msg.id).done_at, null);

    const cross = await t.req('POST', `/api/owner/${other.id}/items/${msg.id}?key=${ownerKey(t.config, other.id)}`, { body: { done: true } });
    assert.equal(cross.status, 404, "a shop can't change another shop's callbacks");
  } finally { await t.close(); }
});

test('every email links to the dashboard', async () => {
  const t = await startApp();
  try {
    const shop = await liveShop(t);
    const welcome = t.mailer.sent.find((m) => m.to === 'pat@maplerow.example' && /is live/.test(m.subject));
    assert.match(welcome.html, /Open your dashboard/);
    assert.match(welcome.text, /Your dashboard \(bookmark it\): https:\/\/desk\.example\.com\/my\//);
    await overnightCall(t, shop.id, 'call_2');
    await new Promise((r) => setTimeout(r, 30));
    const summary = t.mailer.sent.find((m) => /Call summary/.test(m.subject));
    assert.match(summary.html, new RegExp(`/my/${shop.id}\\?key=${ownerKey(t.config, shop.id)}`));
  } finally { await t.close(); }
});

test('the morning report goes out once at 7 AM shop time, callbacks first', async () => {
  const t = await startApp();
  try {
    const shop = await liveShop(t);
    await overnightCall(t, shop.id, 'call_3');
    t.mailer.sent.length = 0;
    const at = next705();
    const deps = { db: t.db, mailer: t.mailer, config: t.config, logger: { log() {}, error() {} } };

    assert.equal((await runMorningReports({ ...deps, now: () => new Date(at.getTime() - 30 * 60_000) })).sent, 0, '6:35 AM is too early');
    assert.equal((await runMorningReports({ ...deps, now: () => at })).sent, 1);
    const m = t.mailer.sent.at(-1);
    assert.equal(m.to, 'pat@maplerow.example');
    assert.equal(m.subject, 'Urgent callbacks · Overnight at Maple Row Heating & Air: 1 call, 1 to call back');
    assert.match(m.text, /CALL BACK TODAY\n- \[Priority\] Dana Ruiz \+15135550177: No heat, two kids at home/);
    assert.match(m.html, /Open your dashboard/);
    assert.equal((await runMorningReports({ ...deps, now: () => new Date(at.getTime() + 20 * 60_000) })).sent, 0, 'once a day');
  } finally { await t.close(); }
});

test('a quiet night sends no morning report', async () => {
  const t = await startApp();
  try {
    await liveShop(t);
    t.mailer.sent.length = 0;
    const r = await runMorningReports({ db: t.db, mailer: t.mailer, config: t.config, logger: { log() {}, error() {} }, now: next705 });
    assert.equal(r.sent, 0);
    assert.equal(t.mailer.sent.length, 0);
  } finally { await t.close(); }
});

test('the operator can email a report now, and copy the dashboard link from admin', async () => {
  const t = await startApp();
  try {
    const shop = await liveShop(t);
    await overnightCall(t, shop.id, 'call_4');
    t.mailer.sent.length = 0;
    const r = await t.req('POST', `/api/admin/clients/${shop.id}/send-report`, auth);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.sent, r.json.calls, r.json.callbacks], [true, 1, 1]);
    assert.equal(t.mailer.sent.length, 1);
    const detail = await t.req('GET', `/api/admin/clients/${shop.id}`, auth);
    assert.equal(detail.json.ownerUrl, ownerUrl(t.config, shop));
  } finally { await t.close(); }
});

test('report email lists bookings by time and escapes caller text', () => {
  const m = morningReportEmail({ brandName: 'AfterHours Desk' }, { business: 'Shop', contact: 'Pat', email: 'p@x.example' }, {
    calls: [{}, {}],
    callbacks: [],
    booked: [{ kind: 'booking', slot_label: 'Monday, 8 AM to 10 AM', caller_name: '<b>Eve</b>', caller_phone: '+15135550100', address: '1 Main', issue: 'Noisy unit', urgency: 'Routine' }],
  });
  assert.equal(m.subject, 'Overnight at Shop: 2 calls, 1 booked');
  assert.match(m.html, /&lt;b&gt;Eve&lt;\/b&gt;/);
  assert.doesNotMatch(m.html, /Open your dashboard/, 'no link without a server secret');
});
