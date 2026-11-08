import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, SECRET, ADMIN } from './helpers.js';
import { ownerKey } from '../src/owner.js';
import { seal, unseal, signState, readState } from '../src/integrations/vault.js';

// A fake of the Jobber and Housecall Pro APIs that records every request.
function fakeTools({ failJobs = false } = {}) {
  const log = [];
  let n = 0;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url), body = opts.body;
    const entry = { url: u.pathname + u.search, host: u.host, method: opts.method || 'GET', headers: opts.headers || {}, body };
    log.push(entry);
    if (u.host === 'api.getjobber.com' && u.pathname === '/api/oauth/token') {
      const p = new URLSearchParams(body);
      return reply(200, { access_token: `jat_${p.get('grant_type')}_${++n}`, refresh_token: `jrt_${n}`, expires_in: 3600 });
    }
    if (u.host === 'api.getjobber.com' && u.pathname === '/api/graphql') {
      const { query, variables } = JSON.parse(body);
      entry.gql = { query, variables };
      if (query.includes('account')) return reply(200, { data: { account: { name: 'Maple Row (Jobber)' } } });
      if (query.includes('clients(')) return reply(200, { data: { clients: { nodes: [] } } });
      if (query.includes('clientCreate')) return reply(200, { data: { clientCreate: { client: { id: 'JC1' }, userErrors: [] } } });
      if (query.includes('propertyCreate')) return reply(200, { data: { propertyCreate: { properties: [{ id: 'JP1' }], userErrors: [] } } });
      if (query.includes('requestCreate')) return reply(200, { data: { requestCreate: { request: { id: 'JR1' }, userErrors: [] } } });
    }
    if (u.host === 'api.housecallpro.com') {
      if (opts.headers?.Authorization !== 'Token hcp_live_key_123456') return reply(401, { message: 'unauthorized' });
      if (u.pathname === '/company') return reply(200, { name: 'Maple Row (HCP)' });
      if (u.pathname === '/customers' && entry.method === 'GET') return reply(200, { customers: [] });
      if (u.pathname === '/customers') return reply(201, { id: 'cus_1', addresses: [{ id: 'adr_1' }] });
      if (u.pathname === '/jobs') return failJobs ? reply(422, { message: 'schedule is invalid' }) : reply(201, { id: 'job_1' });
      if (/^\/jobs\/[^/]+\/notes$/.test(u.pathname)) return reply(201, { id: 'note_1' });
    }
    return reply(404, { message: `no fake for ${u.host}${u.pathname}` });
  };
  return { fetchImpl, log };
}

async function shopWithTools(env = {}) {
  const t = await startApp({ env: { JOBBER_CLIENT_ID: 'jid', JOBBER_CLIENT_SECRET: 'jsecret', ...env } });
  const r = await t.req('POST', '/api/signup', { body: validSignup() });
  await t.idle();
  const id = r.json.client.id;
  return { t, id, key: ownerKey(t.config, id) };
}

async function book(t, id) {
  const hook = (message) => t.req('POST', `/api/vapi/webhook?client=${id}&token=${SECRET}`, { body: { message } });
  const slots = JSON.parse((await hook({ type: 'tool-calls', call: { id: 'call_b' }, toolCallList: [{ id: 'a', function: { name: 'check_availability', arguments: {} } }] })).json.results[0].result).slots;
  const r = await hook({ type: 'tool-calls', call: { id: 'call_b' }, toolCallList: [{ id: 'b', function: { name: 'book_appointment', arguments: { name: 'Laura Smith', phone: '+15135550191', address: '412 Elm St, Mason', issue: 'Furnace short-cycling', urgency: 'Routine', slot_start: slots[0].slot_start } } }] });
  assert.match(r.json.results[0].result, /"booked":true/);
  await t.idle();
  return (await t.db.listBookings(id)).find((b) => b.kind === 'booking');
}

test('tokens and keys are stored encrypted, and sign-in state cannot be forged or reused late', () => {
  const config = { webhookSecret: 'a-long-server-secret-0123456789' };
  const sealed = seal(config, { apiKey: 'hcp_live_key_123456' });
  assert.doesNotMatch(sealed, /hcp_live_key/);
  assert.deepEqual(unseal(config, sealed), { apiKey: 'hcp_live_key_123456' });
  assert.equal(unseal({ webhookSecret: 'another-secret-entirely-xyz' }, sealed), null);
  const st = signState(config, 'client-1');
  assert.deepEqual(readState(config, st), { clientId: 'client-1' });
  assert.equal(readState(config, st.replace('client-1', 'client-2')), null, 'tampered');
  assert.equal(readState(config, st, Date.now() + 21 * 60_000), null, 'expired');
});

test('Jobber: the owner signs in, and a booked visit becomes a Jobber client, property and request', async () => {
  const tools = fakeTools();
  const { t, id, key } = await shopWithTools();
  try {
    t.app.locals.deps.syncFetch = tools.fetchImpl; // the server sends outside API calls through deps.syncFetch

    const before = (await t.req('GET', `/api/owner/${id}?key=${key}`)).json.integration;
    assert.deepEqual(before, { connected: null, jobberAvailable: true });

    const start = await fetch(`${t.base}/api/owner/${id}/integrations/jobber/start?key=${key}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('location'));
    assert.equal(auth.origin + auth.pathname, 'https://api.getjobber.com/api/oauth/authorize');
    assert.equal(auth.searchParams.get('client_id'), 'jid');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://desk.example.com/api/integrations/jobber/callback');

    const cb = await fetch(`${t.base}/api/integrations/jobber/callback?code=abc&state=${encodeURIComponent(auth.searchParams.get('state'))}`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location'), new RegExp(`/my/${id}\\?key=${key}&connected=jobber$`));
    const tokenCall = tools.log.find((l) => l.url === '/api/oauth/token');
    assert.equal(new URLSearchParams(tokenCall.body).get('grant_type'), 'authorization_code');

    const after = (await t.req('GET', `/api/owner/${id}?key=${key}`)).json.integration.connected;
    assert.deepEqual([after.provider, after.name, after.account], ['jobber', 'Jobber', 'Maple Row (Jobber)']);
    assert.doesNotMatch((await t.db.getIntegration(id)).secret, /jat_/, 'tokens are encrypted at rest');

    const b = await book(t, id);
    assert.equal(b.sync_status, 'synced');
    assert.equal(b.sync_ref, 'JR1');
    const gql = tools.log.filter((l) => l.gql);
    assert.ok(gql.every((l) => l.headers['X-JOBBER-GRAPHQL-VERSION'] && l.headers.Authorization.startsWith('Bearer jat_')));
    const client = gql.find((l) => l.gql.query.includes('clientCreate')).gql.variables.input;
    assert.deepEqual([client.firstName, client.lastName, client.phones[0].number], ['Laura', 'Smith', '+15135550191']);
    assert.equal(gql.find((l) => l.gql.query.includes('propertyCreate')).gql.variables.input.properties[0].address.street1, '412 Elm St, Mason');
    const req = gql.find((l) => l.gql.query.includes('requestCreate')).gql.variables.input;
    assert.equal(req.clientId, 'JC1'); assert.equal(req.propertyId, 'JP1');
    assert.match(req.title, /Furnace short-cycling \(booked by AI receptionist\)$/);
  } finally { await t.close(); }
});

test('Jobber tokens are refreshed when they expire, and the new refresh token is kept', async () => {
  const tools = fakeTools();
  const { t, id } = await shopWithTools();
  try {
    t.app.locals.deps.syncFetch = tools.fetchImpl;
    const { saveIntegration } = await import('../src/integrations/sync.js');
    await saveIntegration({ db: t.db, config: t.config }, id, 'jobber', { accessToken: 'old', refreshToken: 'jrt_old', expiresAt: Date.now() - 1000 }, 'Shop');
    const b = await book(t, id);
    assert.equal(b.sync_status, 'synced');
    const refresh = tools.log.find((l) => l.url === '/api/oauth/token');
    assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), 'jrt_old');
    const stored = unseal(t.config, (await t.db.getIntegration(id)).secret);
    assert.match(stored.refreshToken, /^jrt_\d+$/);
    assert.notEqual(stored.refreshToken, 'jrt_old');
  } finally { await t.close(); }
});

test('Housecall Pro: a wrong key is refused, the right one connects, and a visit becomes a scheduled job', async () => {
  const tools = fakeTools();
  const { t, id, key } = await shopWithTools();
  try {
    t.app.locals.deps.syncFetch = tools.fetchImpl;
    const bad = await t.req('POST', `/api/owner/${id}/integrations/housecall?key=${key}`, { body: { apiKey: 'wrong_key_000000' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /did not accept the API key/);
    const ok = await t.req('POST', `/api/owner/${id}/integrations/housecall?key=${key}`, { body: { apiKey: 'hcp_live_key_123456' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.integration.connected.account, 'Maple Row (HCP)');

    const b = await book(t, id);
    assert.equal(b.sync_status, 'synced'); assert.equal(b.sync_ref, 'job_1');
    const cust = JSON.parse(tools.log.find((l) => l.url === '/customers' && l.method === 'POST').body);
    assert.deepEqual([cust.first_name, cust.last_name, cust.mobile_number, cust.addresses[0].street], ['Laura', 'Smith', '+15135550191', '412 Elm St, Mason']);
    const job = JSON.parse(tools.log.find((l) => l.url === '/jobs').body);
    assert.equal(job.customer_id, 'cus_1'); assert.equal(job.address_id, 'adr_1');
    assert.equal(Date.parse(job.schedule.scheduled_end) - Date.parse(job.schedule.scheduled_start), 2 * 3_600_000);
    assert.equal(job.schedule.scheduled_start, b.slot_start);
  } finally { await t.close(); }
});

test('a failed sync never blocks the booking, shows the reason, and can be retried', async () => {
  const tools = fakeTools({ failJobs: true });
  const { t, id, key } = await shopWithTools();
  try {
    t.app.locals.deps.syncFetch = tools.fetchImpl;
    await t.req('POST', `/api/owner/${id}/integrations/housecall?key=${key}`, { body: { apiKey: 'hcp_live_key_123456' } });
    const b = await book(t, id);
    assert.equal(b.sync_status, 'failed');
    assert.match(b.sync_error, /schedule is invalid/);
    const item = (await t.req('GET', `/api/owner/${id}?key=${key}`)).json.items.find((i) => i.id === b.id);
    assert.equal(item.sync_status, 'failed');

    const fixed = fakeTools(); t.app.locals.deps.syncFetch = fixed.fetchImpl;
    const retry = await t.req('POST', `/api/owner/${id}/items/${b.id}/sync?key=${key}`);
    assert.deepEqual(retry.json, { status: 'synced', ref: 'job_1' });
    const again = await t.req('POST', `/api/owner/${id}/items/${b.id}/sync?key=${key}`);
    assert.equal(again.json.status, 'synced');
    assert.equal(fixed.log.filter((l) => l.url === '/jobs').length, 1, 'a synced booking is never sent twice');

    await t.req('DELETE', `/api/owner/${id}/integrations?key=${key}`);
    assert.equal((await t.req('GET', `/api/owner/${id}?key=${key}`)).json.integration.connected, null);
  } finally { await t.close(); }
});

test('without Jobber app keys the button is hidden and the start link explains why; shops without a tool sync nothing', async () => {
  const tools = fakeTools();
  const t = await startApp();
  try {
    t.app.locals.deps.syncFetch = tools.fetchImpl;
    const r = await t.req('POST', '/api/signup', { body: validSignup() }); await t.idle();
    const id = r.json.client.id, key = ownerKey(t.config, id);
    assert.equal((await t.req('GET', `/api/owner/${id}?key=${key}`)).json.integration.jobberAvailable, false);
    assert.equal((await t.req('GET', `/api/owner/${id}/integrations/jobber/start?key=${key}`)).status, 501);
    const b = await book(t, id);
    assert.equal(b.sync_status, null);
    assert.equal(tools.log.length, 0);
    const forged = await fetch(`${t.base}/api/integrations/jobber/callback?code=x&state=forged.1.2.3`, { redirect: 'manual' });
    assert.equal(forged.status, 400);
  } finally { await t.close(); }
});
