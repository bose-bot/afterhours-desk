import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, firstMessage } from '../src/prompt.js';
import { startApp, validSignup, ADMIN } from './helpers.js';

const client = { business: 'Maple Row Heating & Air', details: { area: 'Mason', schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' } } };
const prompt = buildSystemPrompt(client);
const site = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\\'/g, "'");

// The website promises what callers will hear. These lines must match the AI's instructions word for word.
const SHARED = [
  'Please leave the building right away and call 911 or your gas company from outside. Your safety comes first.',
  "I can book a visit or take a message for the team.",
  "That depends on your home and the system, so I can't give an exact price over the phone.",
  'A technician can look and give you a price. Would you like me to book a visit?',
  "The tech will call when they're on the way.",
  "I'll have a team member call you back. What's the best number?",
];

for (const line of SHARED) {
  test(`website and AI script both say: "${line.slice(0, 48)}…"`, () => {
    assert.ok(prompt.includes(line), 'missing from the AI script');
    assert.ok(site.includes(line), 'missing from the website');
  });
}

test('the greeting names the shop and offers what it can do', () => {
  assert.equal(firstMessage(client), 'Thanks for calling Maple Row Heating & Air, this is the virtual assistant. I can book a visit or take a message for the team. How can I help?');
});

test('the example calls use the real business name, and the facts come after them', () => {
  assert.match(prompt, /I'm an AI assistant for Maple Row Heating & Air\./);
  assert.ok(prompt.indexOf('EXAMPLE CALLS') < prompt.indexOf('BUSINESS FACTS'));
});

test('Update script pushes the new wording to a live receptionist', async () => {
  const t = await startApp();
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    const id = r.json.client.id;
    const res = await t.req('POST', `/api/admin/clients/${id}/update-script`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 200);
    const [, assistantId, body] = t.vapi.calls.find(([n]) => n === 'updateAssistant');
    assert.equal(assistantId, (await t.db.getClient(id)).vapiAssistantId);
    assert.match(body.model.messages[0].content, /EXAMPLE CALLS/);
    assert.match(body.firstMessage, /^Thanks for calling Maple Row/);
    assert.equal(body.model.tools.length, 3);
  } finally { await t.close(); }
});

test('Update script explains when there is nothing to update yet', async () => {
  const t = await startApp({ env: { PROVISION_MODE: 'approval' } });
  try {
    const r = await t.req('POST', '/api/signup', { body: validSignup() });
    await t.idle();
    const res = await t.req('POST', `/api/admin/clients/${r.json.client.id}/update-script`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /no receptionist yet/);
  } finally { await t.close(); }
});
