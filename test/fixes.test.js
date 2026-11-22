import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET, ADMIN } from './helpers.js';
import { ownerKey } from '../src/owner.js';
import { openSlots } from '../src/scheduling.js';
import { buildSystemPrompt } from '../src/prompt.js';

const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };
const SMS = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15135550000' };

async function liveShop(t, over = {}) {
  const r = await t.req('POST', '/api/signup', { body: validSignup(over) });
  await t.idle();
  return t.db.getClient(r.json.client.id);
}
const hook = (t, id, message) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message } });
async function tool(t, id, name, args, { callId = 'call_x', caller = '' } = {}) {
  const r = await hook(t, id, { type: 'tool-calls', call: { id: callId, customer: { number: caller } }, toolCallList: [{ id: `tc_${name}`, function: { name, arguments: args } }] });
  return JSON.parse(r.json.results[0].result);
}
const owner = (t, c) => `?key=${ownerKey(t.config, c.id)}`;
const saveSettings = (t, c, body) => t.req('POST', `/api/owner/${c.id}/settings${owner(t, c)}`, { body });
// A fake Twilio that records every text.
function texts(t) {
  const sent = [];
  t.app.locals.deps.syncFetch = async (url, opts) => {
    if (String(url).endsWith('/Messages.json')) { const f = new URLSearchParams(opts.body); sent.push({ to: f.get('To'), from: f.get('From'), body: f.get('Body') }); }
    return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }) };
  };
  return sent;
}
const book = (t, c, slot, name, phone = '+15135550191') => tool(t, c.id, 'book_appointment', { name, phone, address: '1 Main St', issue: 'No heat', urgency: 'Routine', slot_start: slot });

// ---- Jobs per window and days off
test('a shop that can do 2 jobs at once gets 2 bookings per window, and the third caller is offered another time', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    assert.equal((await saveSettings(t, c, { capacity: 2 })).status, 200);
    const first = (await tool(t, c.id, 'check_availability', {})).slots[0].slot_start;
    assert.equal((await book(t, c, first, 'Ann')).booked, true);
    assert.equal((await tool(t, c.id, 'check_availability', {})).slots[0].slot_start, first, 'still one seat left');
    assert.equal((await book(t, c, first, 'Ben')).booked, true);
    assert.notEqual((await tool(t, c.id, 'check_availability', {})).slots[0].slot_start, first, 'now full');
    assert.equal((await book(t, c, first, 'Cal')).booked, false);
  } finally { await t.close(); }
});

test('days off are never offered', () => {
  const schedule = { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '12:00', windowHours: 2, timezone: 'America/New_York', closed: [{ from: '2026-12-24', to: '2026-12-26', note: 'Christmas' }] };
  const slots = openSlots(schedule, { now: new Date('2026-12-23T20:00:00Z'), limit: 20 });
  const days = new Set(slots.map((s) => s.label.split(',')[0] + s.label.split(',')[1]));
  assert.ok(![...days].some((d) => /December 2[456]/.test(d)), [...days].join(' | '));
  assert.ok([...days].some((d) => /December 27/.test(d)));
});

// ---- Settings
test('the owner changes hours, services and days off, and the live receptionist is updated at once', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const r = await saveSettings(t, c, { services: 'Boilers only', dayStart: '07:00', dayEnd: '19:00', workDays: 'mon-sat', windowHours: 3, closed: [{ from: '2099-01-01', to: '2099-01-02', note: 'New Year' }], oncall: '(513) 555-0111', business: 'Hacked Name', email: 'x@evil.example' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.live, true);
    const saved = await t.db.getClient(c.id);
    assert.equal(saved.business, c.business, 'business name and email cannot be changed here');
    assert.equal(saved.email, c.email);
    assert.equal(saved.details.services, 'Boilers only');
    assert.deepEqual([saved.details.schedule.start, saved.details.schedule.end, saved.details.schedule.windowHours], ['07:00', '19:00', 3]);
    assert.deepEqual(saved.details.schedule.days, [1, 2, 3, 4, 5, 6]);
    assert.equal(saved.details.oncall, '+15135550111');
    const [, , body] = t.vapi.calls.findLast(([n]) => n === 'updateAssistant');
    assert.match(body.model.messages[0].content, /Services: Boilers only/);
    const view = (await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`)).json.settings;
    assert.equal(view.workDays, 'mon-sat');
    assert.equal(view.closed[0].note, 'New Year');
  } finally { await t.close(); }
});

test('bad settings are refused with a reason, and nothing changes', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const r = await saveSettings(t, c, { dayStart: '18:00', dayEnd: '09:00', capacity: 99, reviewUrl: 'not a link', closed: [{ from: '2099-02-02', to: '2099-02-01' }] });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.dayEnd && r.json.errors.capacity && r.json.errors.reviewUrl && r.json.errors.closed);
    assert.deepEqual((await t.db.getClient(c.id)).details.schedule, c.details.schedule);
    assert.equal((await t.req('POST', `/api/owner/${c.id}/settings?key=nope`, { body: {} })).status, 404);
  } finally { await t.close(); }
});

// ---- Cancel and reschedule
test('a caller finds, moves and cancels their own visit; nobody else can', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const slots = (await tool(t, c.id, 'check_availability', {})).slots;
    await book(t, c, slots[0].slot_start, 'Laura Smith', '513-555-0191');

    const found = await tool(t, c.id, 'find_booking', { phone: '(513) 555-0191' });
    assert.equal(found.bookings.length, 1);
    const id = found.bookings[0].booking_id;
    assert.equal((await tool(t, c.id, 'find_booking', { phone: '513-555-0000' })).bookings.length, 0);
    assert.equal((await tool(t, c.id, 'cancel_appointment', { booking_id: id, phone: '513-555-0000' })).canceled, false, 'wrong number');

    const moved = await tool(t, c.id, 'reschedule_appointment', { booking_id: id, phone: '5135550191', slot_start: slots[1].slot_start });
    assert.equal(moved.rescheduled, true, JSON.stringify(moved));
    await t.idle();
    assert.ok(t.mailer.sent.some((m) => /^Rescheduled: Laura Smith/.test(m.subject)));
    const now = (await tool(t, c.id, 'find_booking', { phone: '5135550191' })).bookings;
    assert.equal(now.length, 1);
    assert.equal(now[0].window, slots[1].label);
    assert.equal((await tool(t, c.id, 'check_availability', {})).slots[0].slot_start, slots[0].slot_start, 'the old window is free again');

    // Found by caller ID too, without saying the number.
    const viaCallerId = await tool(t, c.id, 'cancel_appointment', { booking_id: now[0].booking_id, phone: '' }, { caller: '+15135550191' });
    assert.equal(viaCallerId.canceled, true);
    await t.idle();
    assert.ok(t.mailer.sent.some((m) => /^Cancelled: Laura Smith/.test(m.subject)));
    assert.equal((await tool(t, c.id, 'find_booking', { phone: '5135550191' })).bookings.length, 0);
    const dash = (await t.req('GET', `/api/owner/${c.id}${owner(t, c)}`)).json;
    assert.ok(!dash.items.some((b) => b.kind === 'booking'), 'cancelled visits leave the dashboard and calendar');
    assert.match(buildSystemPrompt(c), /CHANGING OR CANCELLING A VISIT/);
  } finally { await t.close(); }
});

// ---- Texts
test('texts: urgent alerts to the owner, a confirmation to the caller, nothing when switched off', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    await tool(t, c.id, 'take_message', { name: 'Dana', phone: '513-555-0177', issue: 'Gas smell', urgency: 'Emergency' });
    await tool(t, c.id, 'take_message', { name: 'Joe', phone: '513-555-0123', issue: 'Quote please', urgency: 'Routine' });
    const slot = (await tool(t, c.id, 'check_availability', {})).slots[0].slot_start;
    await book(t, c, slot, 'Laura');
    await t.idle();
    assert.deepEqual(sent.filter((s) => s.to === c.phone).map((s) => s.body.split(':')[0]), ['EMERGENCY'], 'only the emergency reaches the owner by default');
    const conf = sent.find((s) => s.to === '+15135550191');
    assert.match(conf.body, /you're booked for/);
    assert.equal(conf.from, '+15135550000');

    await saveSettings(t, c, { smsAlerts: 'off', textCallers: false });
    sent.length = 0;
    await tool(t, c.id, 'take_message', { name: 'Dana', phone: '513-555-0177', issue: 'Gas smell', urgency: 'Emergency' });
    await t.idle();
    assert.equal(sent.length, 0);
  } finally { await t.close(); }
});

test('texts: a caller who hangs up straight away gets a text-back when the shop wants it', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    await hook(t, c.id, { type: 'end-of-call-report', call: { id: 'c1', customer: { number: '+15135550166' } }, durationSeconds: 6 });
    assert.equal(sent.length, 0, 'off by default');
    await saveSettings(t, c, { textBack: true });
    await hook(t, c.id, { type: 'end-of-call-report', call: { id: 'c2', customer: { number: '+15135550166' } }, durationSeconds: 6 });
    await hook(t, c.id, { type: 'end-of-call-report', call: { id: 'c3', customer: { number: '+15135550167' } }, durationSeconds: 140 });
    await t.idle();
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Sorry we missed you/);
  } finally { await t.close(); }
});

test('the owner asks a past customer for a review, once', async () => {
  const t = await startApp({ env: SMS });
  try {
    const sent = texts(t);
    const c = await liveShop(t);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const b = await t.db.addBooking({ clientId: c.id, kind: 'booking', slotStart: past, slotLabel: 'yesterday', callerName: 'Laura Smith', callerPhone: '513-555-0191', capacity: 1 });
    const url = `/api/owner/${c.id}/items/${b.id}/review${owner(t, c)}`;
    assert.equal((await t.req('POST', url)).status, 409, 'needs a review link first');
    await saveSettings(t, c, { reviewUrl: 'https://g.page/r/maple-row/review' });
    assert.equal((await t.req('POST', url)).status, 200);
    assert.match(sent.at(-1).body, /Hi Laura, thanks for choosing Maple Row/);
    assert.equal((await t.req('POST', url)).status, 409, 'only once');
  } finally { await t.close(); }
});

// ---- Spanish
test('a US shop can answer in English and Spanish', async () => {
  const t = await startApp();
  try {
    await liveShop(t, { language: 'en-es' });
    const [, body] = t.vapi.calls.find(([n]) => n === 'createAssistant');
    assert.deepEqual(body.transcriber, { provider: 'deepgram', model: 'nova-3', language: 'multi' });
    assert.match(body.model.messages[0].content, /Callers may speak English or Spanish/);
  } finally { await t.close(); }
  const e = await startApp();
  try {
    await liveShop(e);
    const [, body] = e.vapi.calls.find(([n]) => n === 'createAssistant');
    assert.equal(body.transcriber, undefined, 'plain English keeps the default');
    assert.doesNotMatch(body.model.messages[0].content, /Spanish/);
  } finally { await e.close(); }
});

// ---- Deleting data
test('the admin deletes a shop and everything about it; the owner can ask for it', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    await tool(t, c.id, 'take_message', { name: 'Dana', phone: '513-555-0177', issue: 'x', urgency: 'Routine' });
    assert.equal((await t.req('POST', `/api/owner/${c.id}/close${owner(t, c)}`, { body: {} })).status, 200);
    assert.ok(t.mailer.sent.some((m) => m.to === 'owner@desk.example.com' && /Close account and delete data/.test(m.subject)));
    assert.ok((await t.db.getClient(c.id)).details.closeRequestedAt);

    assert.equal((await t.req('DELETE', `/api/admin/clients/${c.id}`, { ...auth, body: { confirm: 'wrong' } })).status, 400);
    const r = await t.req('DELETE', `/api/admin/clients/${c.id}`, { ...auth, body: { confirm: c.business } });
    assert.equal(r.status, 200);
    assert.ok(!(await t.db.getClient(c.id)));
    assert.equal((await t.db.listBookings(c.id)).length, 0);
    assert.ok(t.vapi.calls.some(([n, id]) => n === 'deletePhoneNumber' && id === c.vapiPhoneId));
    assert.ok(t.vapi.calls.some(([n, id]) => n === 'deleteAssistant' && id === c.vapiAssistantId));
  } finally { await t.close(); }
});

test('the terms page is published and linked from sign-up', async () => {
  const t = await startApp();
  try {
    const r = await t.req('GET', '/terms');
    assert.equal(r.status, 200);
    assert.match(r.text, /Terms of service/);
    assert.match((await t.req('GET', '/')).text, /href="\/terms"/);
  } finally { await t.close(); }
});
