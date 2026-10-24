import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

export const SECRET = 'test-webhook-secret-0123456789abcdef';
export const ADMIN = 'test-admin-token-0123456789abcdefgh';

export function fakeVapi({ failPhone = false, numberLater = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    failPhone,
    async createAssistant(body) { calls.push(['createAssistant', body]); return { id: `asst_${++n}` }; },
    async deleteAssistant(id) { calls.push(['deleteAssistant', id]); return {}; },
    async createPhoneNumber(body) {
      calls.push(['createPhoneNumber', body]);
      if (this.failPhone) { const e = new Error('Vapi POST /phone-number failed (400): no numbers available'); throw e; }
      return { id: `pn_${++n}`, number: numberLater ? undefined : '+15135550199' };
    },
    async getPhoneNumber(id) { calls.push(['getPhoneNumber', id]); return { id, number: '+15135550177' }; },
  };
}

export function fakeMailer() {
  const sent = [];
  return { sent, enabled: true, async send(m) { if (m.to) sent.push(m); } };
}

export const quietLogger = { log() {}, warn() {}, error() {} };

export async function startApp({ env = {}, vapi = fakeVapi(), now } = {}) {
  const config = loadConfig({
    PUBLIC_URL: 'https://desk.example.com',
    VAPI_API_KEY: 'test',
    WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN: ADMIN,
    OPERATOR_EMAIL: 'owner@desk.example.com',
    ...env,
  });
  const db = openDb(':memory:');
  const mailer = fakeMailer();
  const app = createApp({ db, vapi, mailer, config, logger: quietLogger, numberPollDelayMs: 0, now });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, path, { body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  return {
    app, db, vapi, mailer, config, req,
    idle: () => app.locals.idle(),
    close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
  };
}

export const validSignup = (over = {}) => ({
  business: 'Maple Row Heating & Air',
  contact: 'Pat Jones',
  email: 'pat@maplerow.example',
  phone: '(513) 555-0142',
  area: 'Cincinnati, Blue Ash, Mason',
  workDays: 'mon-fri',
  dayStart: '08:00',
  dayEnd: '16:00',
  timezone: 'America/New_York',
  fee: '$89, waived with repair',
  oncall: '513-555-0100',
  ...over,
});
