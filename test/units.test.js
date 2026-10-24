import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, validateSignup } from '../src/validate.js';
import { openSlots, zonedToUtc, describeSchedule } from '../src/scheduling.js';
import { buildSystemPrompt, toolDefinitions } from '../src/prompt.js';
import { configProblems, loadConfig } from '../src/config.js';
import { extractToolCalls } from '../src/webhook.js';

test('normalizePhone handles common US formats', () => {
  assert.equal(normalizePhone('(513) 555-0142'), '+15135550142');
  assert.equal(normalizePhone('1-513-555-0142'), '+15135550142');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('555-0142'), '');
  assert.equal(normalizePhone(''), '');
});

test('validateSignup requires the basics and derives the area code', () => {
  const bad = validateSignup({ business: '', email: 'nope', phone: '12' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.business && bad.errors.contact && bad.errors.email && bad.errors.phone);

  const good = validateSignup({ business: 'A', contact: 'B', email: 'B@Example.com', phone: '513 555 0142' });
  assert.equal(good.ok, true);
  assert.equal(good.value.email, 'b@example.com');
  assert.equal(good.value.areaCode, '513');
  assert.deepEqual(good.value.schedule.days, [1, 2, 3, 4, 5]);
});

test('validateSignup rejects closing before opening and unknown time zones', () => {
  const r = validateSignup({ business: 'A', contact: 'B', email: 'b@x.com', phone: '5135550142', dayStart: '17:00', dayEnd: '09:00', timezone: 'Mars/Base' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.dayEnd && r.errors.timezone);
});

test('zonedToUtc respects daylight saving', () => {
  assert.equal(zonedToUtc(2026, 1, 15, 8, 0, 'America/New_York').toISOString(), '2026-01-15T13:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 15, 8, 0, 'America/New_York').toISOString(), '2026-07-15T12:00:00.000Z');
});

test('openSlots skips closed days, past times and booked windows', () => {
  const schedule = { days: [1, 2, 3, 4, 5], start: '08:00', end: '12:00', windowHours: 2, timezone: 'America/New_York' };
  // Friday 2026-10-23, 9:30 AM Eastern.
  const now = new Date('2026-10-23T13:30:00Z');
  const slots = openSlots(schedule, { now, limit: 4 });
  // 8-10 already started; 10-12 starts within 60 min lead; weekend skipped; Monday 8-10 and 10-12 next.
  assert.equal(slots[0].slot_start, '2026-10-26T12:00:00.000Z');
  assert.match(slots[0].label, /Monday, October 26, 8 AM to 10 AM/);
  const booked = new Set([slots[0].slot_start]);
  assert.equal(openSlots(schedule, { now, booked, limit: 1 })[0].slot_start, '2026-10-26T14:00:00.000Z');
});

test('describeSchedule reads naturally', () => {
  assert.equal(describeSchedule({ days: [1, 2, 3, 4, 5], start: '08:00', end: '17:30' }), 'Mon–Fri 8am–5:30pm');
});

test('system prompt carries the safety rule and the business facts', () => {
  const p = buildSystemPrompt({ business: 'Maple Row', details: { area: 'Mason', fee: '$89', schedule: { days: [1], start: '08:00', end: '17:00' } } });
  assert.match(p, /leave the building right away/);
  assert.match(p, /Never claim to be human/);
  assert.match(p, /Service call fee: \$89/);
  assert.match(p, /Hours: Mon 8am–5pm/);
});

test('every tool points at the webhook', () => {
  const tools = toolDefinitions('https://x.example/hook');
  assert.deepEqual(tools.map((t) => t.function.name), ['check_availability', 'book_appointment', 'take_message']);
  assert.ok(tools.every((t) => t.server.url === 'https://x.example/hook'));
});

test('configProblems flags missing and weak settings', () => {
  const problems = configProblems(loadConfig({ PUBLIC_URL: 'http://localhost', WEBHOOK_SECRET: 'short' }));
  assert.equal(problems.length, 4);
});

test('extractToolCalls reads both payload shapes and string arguments', () => {
  const a = extractToolCalls({ toolCallList: [{ id: '1', function: { name: 'x', arguments: '{"a":1}' } }] });
  assert.deepEqual(a, [{ id: '1', name: 'x', args: { a: 1 } }]);
  const b = extractToolCalls({ toolWithToolCallList: [{ name: 'y', toolCall: { id: '2', function: { name: 'y', arguments: { b: 2 } } } }] });
  assert.deepEqual(b, [{ id: '2', name: 'y', args: { b: 2 } }]);
});
