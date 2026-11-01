import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, validSignup, ADMIN } from './helpers.js';
import { readWebsite, extractText, normalizeUrl } from '../src/website.js';

const auth = { Authorization: `Bearer ${ADMIN}` };
const publicDns = async () => [{ address: '93.184.216.34' }];
const page = (html, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => html, body: null,
});
const SITE = `<html><head><title>Queen City Comfort | Heating & Cooling</title><meta name="description" content="Furnace and AC repair in Cincinnati, Norwood and Mason."></head>
<body><nav>Home About</nav><script>var x=1</script><h1>Family-owned since 1998</h1><p>We repair and install furnaces, heat pumps and central air. Open Mon-Sat 7am-7pm.</p></body></html>`;

test('website text keeps title, description and body, and drops scripts and menus', () => {
  const t = extractText(SITE);
  assert.match(t, /^Queen City Comfort \| Heating & Cooling/);
  assert.match(t, /Cincinnati, Norwood and Mason/);
  assert.match(t, /heat pumps and central air/);
  assert.doesNotMatch(t, /var x=1|Home About/);
});

test('only public http(s) websites are read', async () => {
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http and https/);
  assert.equal(normalizeUrl('queencitycomfort.example').toString(), 'https://queencitycomfort.example/');
  const fetchImpl = async () => page(SITE);
  for (const [url, dns] of [['http://localhost:3000', publicDns], ['http://10.0.0.5', publicDns], ['http://[::1]/', publicDns], ['https://sneaky.example', async () => [{ address: '169.254.169.254' }]]]) {
    await assert.rejects(readWebsite(url, { fetchImpl, lookup: dns }), /not a public website/, url);
  }
});

test('a redirect into a private network is refused', async () => {
  const fetchImpl = async (u) => (u.startsWith('https://shop.example') ? page('', 302, { location: 'http://192.168.1.1/admin' }) : page(SITE));
  const lookup = async (h) => (h === 'shop.example' ? [{ address: '93.184.216.34' }] : [{ address: '192.168.1.1' }]);
  await assert.rejects(readWebsite('https://shop.example', { fetchImpl, lookup }), /not a public website/);
});

test('Build a demo: reads the site, builds the receptionist, and gives one reusable number', async () => {
  const t = await startApp({ fetchImpl: async () => page(SITE), lookup: publicDns });
  try {
    const r1 = await t.req('POST', '/api/admin/demo', { headers: auth, body: { business: 'Queen City Comfort', website: 'queencitycomfort.example', area: 'Cincinnati' } });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.demo.business, 'Queen City Comfort');
    assert.ok(r1.json.demo.phoneNumber);
    assert.match(r1.json.demo.learned, /Family-owned since 1998/);
    const created = t.vapi.calls.find(([n]) => n === 'createAssistant')[1];
    assert.match(created.firstMessage, /Thanks for calling Queen City Comfort/);
    assert.match(created.model.messages[0].content, /BEGIN WEBSITE TEXT[\s\S]*heat pumps and central air[\s\S]*END WEBSITE TEXT/);

    // Second prospect: same assistant and number, just re-pointed. No new number bought.
    const r2 = await t.req('POST', '/api/admin/demo', { headers: auth, body: { business: 'Tri-State Air' } });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.demo.phoneNumber, r1.json.demo.phoneNumber);
    assert.equal(t.vapi.calls.filter(([n]) => n === 'createPhoneNumber').length, 1);
    assert.equal(t.vapi.calls.filter(([n]) => n === 'createAssistant').length, 1);
    const upd = t.vapi.calls.find(([n]) => n === 'updateAssistant')[2];
    assert.match(upd.firstMessage, /Thanks for calling Tri-State Air/);
    assert.ok(t.vapi.calls.some(([n, , b]) => n === 'updatePhoneNumber' && b.name === 'Demo: Tri-State Air'));

    // The demo never shows up as a client or counts toward the client cap.
    assert.equal((await t.req('GET', '/api/admin/clients', { headers: auth })).json.clients.length, 0);
    assert.equal((await t.req('GET', '/api/admin/demo', { headers: auth })).json.demo.business, 'Tri-State Air');
  } finally { await t.close(); }
});

test('the operator can still sign up a test shop with their own email after building a demo', async () => {
  const t = await startApp({ fetchImpl: async () => page(SITE), lookup: publicDns });
  try {
    await t.req('POST', '/api/admin/demo', { headers: auth, body: { business: 'Demo Shop' } });
    const r = await t.req('POST', '/api/signup', { body: validSignup({ email: 'owner@desk.example.com' }) });
    assert.equal(r.status, 202, r.text);
    await t.idle();
  } finally { await t.close(); }
});

test('Build a demo explains bad input clearly', async () => {
  const t = await startApp({ fetchImpl: async () => page(SITE), lookup: publicDns });
  try {
    assert.match((await t.req('POST', '/api/admin/demo', { headers: auth, body: {} })).json.error, /Enter the shop's name/);
    assert.match((await t.req('POST', '/api/admin/demo', { headers: auth, body: { business: 'X', website: 'http://localhost' } })).json.error, /not a public website/);
    assert.equal((await t.req('POST', '/api/admin/demo', { body: { business: 'X' } })).status, 401);
  } finally { await t.close(); }
});
