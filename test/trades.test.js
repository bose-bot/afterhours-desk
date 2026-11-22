import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup } from './helpers.js';
import { buildSystemPrompt, firstMessage } from '../src/prompt.js';
import { TRADES, TRADE_CODES } from '../src/trades.js';
import { validateSignup } from '../src/validate.js';

const shop = (trade, over = {}) => ({ business: 'Queen City Pros', status: 'active', details: { trade, area: 'Cincinnati', schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', timezone: 'America/New_York' }, ...over } });

test('every trade has what the script needs', () => {
  for (const code of TRADE_CODES) {
    const T = TRADES[code];
    if (T.fromCountry) continue;
    for (const k of ['dangers', 'urgent', 'defaultServices', 'details', 'bookLine', 'onWay']) assert.ok(T[k], `${code}.${k}`);
    for (const k of ['problem', 'danger', 'price', 'what', 'look']) assert.ok(T.ex[k], `${code}.ex.${k}`);
  }
});

test('an HVAC shop keeps the original script, and a shop without a trade is HVAC', () => {
  assert.equal(buildSystemPrompt(shop('hvac')), buildSystemPrompt(shop(undefined)));
  assert.match(buildSystemPrompt(shop('hvac')), /a heating and air conditioning company/);
});

for (const [trade, checks] of Object.entries({
  plumbing: [/Queen City Pros, a plumbing company serving Cincinnati/, /water near electrical outlets or the electrical panel/, /call 911 or your gas company from outside\. Your safety comes first\. If water is near anything electrical/, /A burst pipe/, /main shut-off valve/, /Water's pouring out from under my kitchen sink/, /A plumber can take a look/],
  electrical: [/an electrical contractor/, /sparking, a burning smell/, /call 911 from outside/, /breaker has tripped/, /An electrician can take a look/],
  roofing: [/a roofing company/, /ceiling sagging/, /active leak/, /A roofer can inspect it/],
  pest: [/a pest control company/, /trouble breathing/, /termite treatment/],
  locksmith: [/a locksmith serving/, /locked in a car/, /Locked out of a home or car/],
  garage: [/a garage door company/, /snapped spring/],
  appliance: [/an appliance repair company/, /fridge or freezer not cooling/],
  cleaning: [/a cleaning company/, /deep clean/],
  landscaping: [/a landscaping and tree care company/, /fallen tree/],
})) {
  test(`${trade}: the script uses that trade's dangers, urgent cases and examples, never HVAC's`, () => {
    const p = buildSystemPrompt(shop(trade));
    for (const re of checks) assert.match(p, re);
    assert.doesNotMatch(p, /furnace|thermostat|heat pump|HVAC/i);
    assert.match(firstMessage(shop(trade)), /I can book a visit or take a message/);
  });
}

test('any other business describes itself, books appointments and never asks for an address it does not need', () => {
  const p = buildSystemPrompt(shop('other', { businessType: 'dental clinic', services: 'cleanings, fillings, whitening' }));
  assert.match(p, /Queen City Pros, a dental clinic serving/);
  assert.match(p, /Services: cleanings, fillings, whitening/);
  assert.match(p, /needs urgent medical help, please hang up and call 911/);
  assert.match(p, /Give professional advice or diagnose problems/);
  assert.doesNotMatch(p, /And the address\?/);
  assert.doesNotMatch(p, /furnace|technician/i);
  assert.match(firstMessage(shop('other', { businessType: 'auto repair shop' })), /I can book an appointment or take a message/);
  assert.match(buildSystemPrompt(shop('other', { businessType: 'auto repair shop' })), /an auto repair shop serving/);
});

test('trades use each country\'s emergency number and address format', () => {
  const gb = buildSystemPrompt({ ...shop('electrical'), details: { ...shop('electrical').details, country: 'GB', schedule: { ...shop('electrical').details.schedule, timezone: 'Europe/London' } } });
  assert.match(gb, /call 999 from outside/);
  assert.match(gb, /town and postcode/);
  assert.match(gb, /Sam Patel/);
  const au = buildSystemPrompt({ ...shop('locksmith'), details: { ...shop('locksmith').details, country: 'AU' } });
  assert.match(au, /call 000 right away/);
  const india = buildSystemPrompt({ ...shop('plumbing'), details: { ...shop('plumbing').details, country: 'IN' } });
  assert.match(india, /Rahul Sharma/);
  assert.match(india, /112/);
  assert.doesNotMatch(india, /AC cooling/);
});

test('sign-up saves the type of business, and "other" needs a description', () => {
  const ok = validateSignup(validSignup({ trade: 'plumbing' }));
  assert.equal(ok.value.trade, 'plumbing');
  assert.equal(validateSignup(validSignup({ trade: 'nonsense' })).value.trade, 'hvac');
  const missing = validateSignup(validSignup({ trade: 'other' }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.businessType, /what your business does/);
  assert.equal(validateSignup(validSignup({ trade: 'other', businessType: 'Hair salon' })).value.businessType, 'Hair salon');
});

test('a plumber signs up and gets a plumbing receptionist', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup({ trade: 'plumbing', business: 'Flow Right Plumbing', services: '' }) });
    assert.equal(r.status, 202);
    await t.idle();
    const [, body] = t.vapi.calls.find(([n]) => n === 'createAssistant');
    assert.match(body.model.messages[0].content, /Flow Right Plumbing, a plumbing company/);
    assert.match(body.model.messages[0].content, /Services: leak and burst pipe repair/);
    assert.equal((await t.db.getClient(r.json.client.id)).details.trade, 'plumbing');
  } finally { await t.close(); }
});
