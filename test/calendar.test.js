import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET } from './helpers.js';
import { ownerKey } from '../src/owner.js';
import { calendarFeed } from '../src/calendar.js';

async function liveShop(t, over = {}) {
  const r = await t.req('POST', '/api/signup', { body: validSignup(over) });
  await t.idle();
  return t.db.getClient(r.json.client.id);
}
const hook = (t, id, message) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message } });
const tool = (t, id, callId, name, args) => hook(t, id, { type: 'tool-calls', call: { id: callId }, toolCallList: [{ id: `tc_${name}`, function: { name, arguments: args } }] });

// A caller books a visit and another leaves a message, exactly as during real calls.
async function bookAndMessage(t, id) {
  const slots = JSON.parse((await tool(t, id, 'call_1', 'check_availability', {})).json.results[0].result).slots;
  await tool(t, id, 'call_1', 'book_appointment', { name: 'Laura Smith', phone: '+15135550191', address: '412 Elm St, Mason, OH', issue: 'Furnace short-cycling; noisy, too', urgency: 'Routine', slot_start: slots[0].slot_start });
  await tool(t, id, 'call_2', 'take_message', { name: 'Dana Ruiz', phone: '+15135550177', issue: 'No heat', urgency: 'Emergency' });
  return slots[0];
}

test('a visit booked on a call is on the dashboard calendar right away, with callbacks beside it', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const slot = await bookAndMessage(t, c.id);
    const r = await t.req('GET', `/api/owner/${c.id}?key=${ownerKey(t.config, c.id)}`);
    assert.equal(r.status, 200);
    const visit = r.json.items.find((b) => b.kind === 'booking');
    assert.equal(visit.slot_start, slot.slot_start);
    assert.equal(visit.caller_name, 'Laura Smith');
    assert.ok(r.json.items.some((b) => b.kind === 'message' && b.urgency === 'Emergency'));
    assert.equal(r.json.windowHours, 2);
    assert.match(r.json.calendarFeed, new RegExp(`^https://desk\\.example\\.com/api/owner/${c.id}/calendar\\.ics\\?key=`));
  } finally { await t.close(); }
});

test('visits from months ago are still on the calendar, listed once', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const past = new Date(Date.now() - 100 * 86_400_000);
    await t.db.addBooking({ clientId: c.id, kind: 'booking', slotStart: past.toISOString(), slotLabel: 'old', callerName: 'Old Visit', callerPhone: '+15135550100', address: '', issue: 'Tune-up', urgency: 'Routine', callId: 'old', createdAt: past.toISOString() });
    const r = await t.req('GET', `/api/owner/${c.id}?key=${ownerKey(t.config, c.id)}`);
    const onCalendar = [...r.json.items, ...r.json.calendar].filter((b) => b.caller_name === 'Old Visit');
    assert.equal(onCalendar.length, 1, 'once, not twice');
  } finally { await t.close(); }
});

test('the calendar feed lists each visit for Google, Apple or Outlook, and needs the shop key', async () => {
  const t = await startApp();
  try {
    const c = await liveShop(t);
    const slot = await bookAndMessage(t, c.id);
    const url = new URL((await t.req('GET', `/api/owner/${c.id}?key=${ownerKey(t.config, c.id)}`)).json.calendarFeed);
    const r = await t.req('GET', `${url.pathname}${url.search}`);
    assert.equal(r.status, 200);
    const ics = r.text.replace(/\r\n /g, '');
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'visits only; callbacks are not events');
    assert.match(ics, /SUMMARY:Visit: Laura Smith \(Furnace short-cycling\\; noisy\\, too\)/);
    assert.match(ics, /LOCATION:412 Elm St\\, Mason\\, OH/);
    const start = new Date(slot.slot_start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const end = new Date(Date.parse(slot.slot_start) + 2 * 3_600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    assert.match(ics, new RegExp(`DTSTART:${start}\\r\\nDTEND:${end}`));
    assert.match(ics, /Phone: \(513\) 555-0191/);
    assert.match(ics, /X-WR-CALNAME:Maple Row Heating & Air visits|X-WR-CALNAME:.+ visits/);

    assert.equal((await t.req('GET', `/api/owner/${c.id}/calendar.ics`)).status, 404);
    assert.equal((await t.req('GET', `/api/owner/${c.id}/calendar.ics?key=nope`)).status, 404);
  } finally { await t.close(); }
});

test('feed lines are folded at 75 bytes and marked done visits show a tick', () => {
  const ics = calendarFeed({ business: 'Shop', details: { schedule: { windowHours: 3 } } }, [
    { id: 'b1', kind: 'booking', slot_start: new Date(Date.now() + 86_400_000).toISOString(), caller_name: 'Ana', issue: 'x'.repeat(200), address: 'é'.repeat(80), created_at: new Date().toISOString(), done_at: new Date().toISOString() },
  ]);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
  assert.match(ics.replace(/\r\n /g, ''), /SUMMARY:✓ Visit: Ana/);
  assert.match(ics, /STATUS:CONFIRMED/);
});
