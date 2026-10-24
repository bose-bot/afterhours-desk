import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { loadConfig, configProblems } from '../src/config.js';
import { ensureSecrets } from '../src/secrets.js';
import { createMailer } from '../src/mailer.js';
import { quietLogger } from './helpers.js';

test('public URL is detected on Render and Railway', () => {
  assert.equal(loadConfig({ RAILWAY_PUBLIC_DOMAIN: 'desk-production.up.railway.app' }).publicUrl, 'https://desk-production.up.railway.app');
  assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://desk.onrender.com/' }).publicUrl, 'https://desk.onrender.com');
  assert.equal(loadConfig({ PUBLIC_URL: 'https://mine.example', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).publicUrl, 'https://mine.example');
});

test('missing secrets are generated once and kept across restarts', () => {
  const db = openDb(':memory:');
  const logs = [];
  const logger = { ...quietLogger, log: (m) => logs.push(m) };

  const first = ensureSecrets(loadConfig({ VAPI_API_KEY: 'k', PUBLIC_URL: 'https://x.example' }), db, logger);
  assert.equal(first.webhookSecret.length, 48);
  assert.equal(first.adminToken.length, 48);
  assert.notEqual(first.webhookSecret, first.adminToken);
  assert.deepEqual(configProblems(first), []);
  assert.equal(logs.length, 1, 'admin token is shown on first start');
  assert.ok(logs[0].includes(first.adminToken));

  const second = ensureSecrets(loadConfig({ VAPI_API_KEY: 'k', PUBLIC_URL: 'https://x.example' }), db, logger);
  assert.equal(second.webhookSecret, first.webhookSecret);
  assert.equal(second.adminToken, first.adminToken);
  assert.equal(logs.length, 1, 'and not shown again');
  db.close();
});

test('secrets set in the environment win over generated ones', () => {
  const db = openDb(':memory:');
  const c = ensureSecrets(loadConfig({ WEBHOOK_SECRET: 'w'.repeat(30), ADMIN_TOKEN: 'a'.repeat(30) }), db, quietLogger);
  assert.equal(c.webhookSecret, 'w'.repeat(30));
  assert.equal(c.adminToken, 'a'.repeat(30));
  assert.equal(db.getSetting('admin_token'), null);
  db.close();
});

test('Resend is used when its key is set', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => '{"id":"1"}' }; };
  const mailer = createMailer(loadConfig({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Desk <hi@desk.example>', SMTP_HOST: 'smtp.example' }).mail, { fetchImpl, logger: quietLogger });
  assert.equal(mailer.provider, 'resend');
  await mailer.send({ to: 'pat@shop.example', subject: 'Hi', text: 'Body' });
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(requests[0].init.body), { from: 'Desk <hi@desk.example>', to: ['pat@shop.example'], subject: 'Hi', text: 'Body' });
});

test('Resend errors are reported, and email is off when nothing is configured', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'domain not verified' });
  const mailer = createMailer(loadConfig({ RESEND_API_KEY: 're_test', MAIL_FROM: 'a@b.example' }).mail, { fetchImpl, logger: quietLogger });
  await assert.rejects(mailer.send({ to: 'x@y.example', subject: 's', text: 't' }), /403.*domain not verified/);
  assert.equal(createMailer(loadConfig({}).mail, { logger: quietLogger }).enabled, false);
});
