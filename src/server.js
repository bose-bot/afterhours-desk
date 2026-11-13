import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSignup } from './validate.js';
import { provisionClient, refreshNumber, updateScript, attachIndianNumber } from './provision.js';
import { buildDemo, currentDemo } from './demo.js';
import { WebsiteError } from './website.js';
import { createWebhookHandler, isAuthorized } from './webhook.js';
import { usageThisMonth, busiestToday } from './usage.js';
import { billingProvider, stripeCheckout, stripeSignatureValid, stripeEventUpdate, razorpaySubscription, razorpaySignatureValid, razorpayEventUpdate, applyBillingUpdate } from './billing.js';
import { countryOf } from './countries.js';
import { recoverCalls } from './recover.js';
import { ownerKeyValid, ownerUrl } from './owner.js';
import { sendReport } from './report.js';
import { PROVIDERS, loadIntegration, saveIntegration, syncBooking, testConnection, jobber } from './integrations/sync.js';
import { signState, readState } from './integrations/vault.js';
import { timingSafeEqual } from 'node:crypto';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Simple per-IP limiter for the public sign-up form.
function rateLimiter(perHour) {
  const hits = new Map();
  return (ip) => {
    const t = Date.now(), windowStart = t - 3_600_000;
    const list = (hits.get(ip) || []).filter((x) => x > windowStart);
    if (list.length >= perHour) { hits.set(ip, list); return false; }
    list.push(t); hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}

// Express 4 doesn't catch errors from async handlers; this passes them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// What the sign-up page may show: progress only, never contact details or internal ids.
function publicView(c) {
  return {
    id: c.id, business: c.business, status: c.status, phoneNumber: c.phoneNumber,
    steps: { script: Boolean(c.vapiAssistantId), number: Boolean(c.vapiPhoneId) },
  };
}

/**
 * deps: { db, vapi, mailer, config, logger, now, numberPollDelayMs }
 * Returns an Express app. app.locals.idle() resolves once background setup jobs finish (used by tests).
 */
export function createApp(deps) {
  const { db, config, logger = console } = deps;
  const app = express();
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.disable('x-powered-by');
  // ---- Billing webhooks: need the raw body to check the signature, so they come before the JSON parser.
  const raw = express.raw({ type: '*/*', limit: '1mb' });
  app.post('/api/billing/stripe/webhook', raw, async (req, res) => {
    const body = req.body?.toString('utf8') || '';
    if (!stripeSignatureValid(config.stripe.webhookSecret, req.get('stripe-signature'), body)) return res.status(400).json({ error: 'bad signature' });
    try { await applyBillingUpdate('stripe', stripeEventUpdate(JSON.parse(body)), deps); res.json({ received: true }); }
    catch (e) { logger.error(`[billing] stripe webhook: ${e.message}`); res.status(500).json({ error: 'failed' }); }
  });
  app.post('/api/billing/razorpay/webhook', raw, async (req, res) => {
    const body = req.body?.toString('utf8') || '';
    if (!razorpaySignatureValid(config.razorpay.webhookSecret, req.get('x-razorpay-signature'), body)) return res.status(400).json({ error: 'bad signature' });
    try { await applyBillingUpdate('razorpay', razorpayEventUpdate(JSON.parse(body)), deps); res.json({ received: true }); }
    catch (e) { logger.error(`[billing] razorpay webhook: ${e.message}`); res.status(500).json({ error: 'failed' }); }
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const jobs = new Set();
  const runInBackground = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => logger.error(`[job] ${e.message}`)).finally(() => jobs.delete(p));
    jobs.add(p);
  };
  app.locals.idle = () => Promise.all([...jobs]);
  app.locals.deps = deps; // tests swap in fake outside APIs here

  const allowSignup = rateLimiter(config.signupsPerIpPerHour);

  // Uptime monitors should watch this: it fails if the database can't be reached, not just if the process is up.
  app.get('/healthz', async (_req, res) => {
    try { await db.ping(); res.json({ ok: true }); }
    catch (e) { logger.error(`[health] ${e.message}`); res.status(503).json({ ok: false, error: 'database unreachable' }); }
  });

  // ---- Public sign-up ----
  app.post('/api/signup', wrap(async (req, res) => {
    const body = req.body || {};
    if (body.website) return res.status(202).json({ ok: true }); // honeypot: bots fill hidden fields

    const check = validateSignup(body, { defaultAreaCode: config.vapi.defaultAreaCode, timezone: config.timezone });
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });
    const v = check.value;

    const existing = await db.findClientByEmail(v.email);
    if (existing && existing.status !== 'failed') {
      return res.status(409).json({ ok: false, errors: { email: 'This email already has a receptionist. Check your inbox, or reply to our email to make changes.' } });
    }
    if (!allowSignup(req.ip || 'unknown')) {
      return res.status(429).json({ ok: false, errors: { form: 'Too many sign-ups from this network. Try again in an hour.' } });
    }
    if (await db.countLiveClients() >= config.maxClients) {
      return res.status(503).json({ ok: false, errors: { form: 'We are at capacity right now. Email us and we will add you to the waitlist.' } });
    }

    const { business, contact, email, phone, ...rest } = v;
    const status = config.provisionMode === 'approval' ? 'pending_approval' : 'provisioning';
    const client = await db.createClient({ status, business, contact, email, phone, details: rest });

    if (status === 'provisioning') runInBackground(() => provisionClient(client.id, deps));
    else runInBackground(() => deps.mailer.send({
      to: config.mail.operatorEmail,
      subject: `Approve new sign-up: ${business}`,
      text: `${business} (${contact}, ${email}) signed up.\nApprove: POST ${config.publicUrl}/api/admin/clients/${client.id}/approve`,
    }));

    return res.status(202).json({ ok: true, client: publicView(client) });
  }));

  // Lets the sign-up page show the new number as soon as it exists. The id is an unguessable UUID.
  app.get('/api/signup/:id', wrap(async (req, res) => {
    const c = await db.getClient(req.params.id);
    if (!c) return res.status(404).json({ ok: false });
    return res.json({ ok: true, client: publicView(c) });
  }));

  // ---- Vapi webhook ----
  app.post('/api/vapi/webhook', wrap(createWebhookHandler(Object.assign(Object.create(deps), { runInBackground }))));

  // ---- Admin (Bearer ADMIN_TOKEN) ----
  const admin = express.Router();
  // The owner's ADMIN_TOKEN, or a support person's token from SUPPORT_TOKENS. Changes are logged with the name.
  const matches = (given, want) => { const a = Buffer.from(given), b = Buffer.from(want || ''); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  admin.use((req, res, next) => {
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const who = matches(given, config.adminToken) ? 'owner' : (config.supportTokens || []).find((t) => matches(given, t.token))?.name;
    if (!who) return res.status(401).json({ error: 'unauthorized' });
    req.adminUser = who;
    if (req.method !== 'GET') logger.log(`[admin] ${who}: ${req.method} ${req.originalUrl}`);
    next();
  });
  admin.get('/me', (req, res) => res.json({ name: req.adminUser }));
  admin.get('/overview', wrap(async (_req, res) => {
    res.json({ busiestToday: await busiestToday(db), lines: config.vapi.concurrency });
  }));
  admin.post('/clients/:id/attach-number', wrap(async (req, res) => {
    try { res.json({ client: await attachIndianNumber(req.params.id, req.body?.number, deps) }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  }));
  const usageOf = (c) => usageThisMonth(db, c, { now: (deps.now || (() => new Date()))(), timezone: config.timezone, includedMinutes: config.includedMinutes });
  admin.get('/clients', wrap(async (_req, res) => {
    const clients = (await db.listClients()).filter((c) => c.status !== 'demo');
    res.json({ clients: await Promise.all(clients.map(async (c) => ({ ...c, usage: await usageOf(c) }))) });
  }));
  // Sends the morning report right now, covering the last 24 hours, even if nothing came in.
  admin.post('/clients/:id/send-report', wrap(async (req, res) => {
    const c = await db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'No client with that id.' });
    if (c.status !== 'active') return res.status(409).json({ error: 'Reports are only sent for live shops.' });
    const r = await sendReport(c, deps, { since: new Date(Date.now() - 24 * 3_600_000).toISOString(), force: true });
    res.json({ ok: true, ...r });
  }));
  admin.post('/recover-calls', async (_req, res) => {
    try { res.json({ ok: true, ...(await recoverCalls(deps)) }); }
    catch (e) { logger.error(`[recover] ${e.message}`); res.status(502).json({ error: e.message }); }
  });
  admin.get('/demo', wrap(async (_req, res) => res.json({ demo: await currentDemo(deps) })));
  admin.post('/demo', async (req, res) => {
    try {
      res.json({ ok: true, demo: await buildDemo(req.body || {}, deps) });
    } catch (e) {
      if (e instanceof WebsiteError || e.status === 400) return res.status(400).json({ error: e.message });
      logger.error(`[demo] ${e.message}`);
      res.status(502).json({ error: e.message });
    }
  });
  admin.get('/clients/:id', wrap(async (req, res) => {
    const c = await db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const integ = await db.getIntegration(c.id);
    res.json({ client: c, usage: await usageOf(c), ownerUrl: c.status === 'demo' ? '' : ownerUrl(config, c),
      integration: integ ? { name: PROVIDERS[integ.provider], account: integ.account_name } : null,
      bookings: await db.listBookings(c.id), calls: await db.listCalls(c.id) });
  }));
  const startSetup = (allowed) => wrap(async (req, res) => {
    const c = await db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (!allowed.includes(c.status)) return res.status(409).json({ error: `Client is ${c.status}.` });
    await db.updateClient(c.id, { status: 'provisioning' });
    runInBackground(() => provisionClient(c.id, deps));
    res.status(202).json({ ok: true });
  });
  admin.post('/clients/:id/approve', startSetup(['pending_approval']));
  admin.post('/clients/:id/retry', startSetup(['failed']));
  admin.post('/clients/:id/update-script', async (req, res) => {
    try {
      const { client, updated } = await updateScript(req.params.id, deps);
      if (!client) return res.status(404).json({ error: 'not found' });
      if (!updated) return res.status(409).json({ error: 'This shop has no receptionist yet. Approve or retry its setup first.' });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  admin.post('/clients/:id/refresh-number', async (req, res) => {
    try { res.json({ client: await refreshNumber(req.params.id, deps) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.use('/api/admin', admin);

  // ---- Shop owner dashboard: /my/<client id>?key=<private key>. Anyone without the key gets a plain 404.
  const ownerGate = wrap(async (req, res, next) => {
    const c = ownerKeyValid(config, req.params.id, String(req.query.key || req.get('x-owner-key') || '')) ? await db.getClient(req.params.id) : null;
    if (!c || c.status === 'demo') return res.status(404).json({ error: 'This dashboard link is not valid. Use the link from your latest email.' });
    req.client = c; next();
  });
  app.get('/my/:id', (_req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
    res.sendFile(join(PUBLIC_DIR, 'my.html'));
  });
  app.get('/api/owner/:id', ownerGate, wrap(async (req, res) => {
    const c = req.client, cutoff = Date.now() - 45 * 86_400_000;
    const recent = (row) => Date.parse(row.created_at) >= cutoff;
    const items = (await db.listBookings(c.id)).filter((b) => recent(b) || (b.kind === 'booking' && Date.parse(b.slot_start) >= Date.now()));
    const calls = (await db.listCalls(c.id)).filter(recent).slice(0, 100).map((k) => ({
      id: k.id, caller_phone: k.caller_phone, summary: k.summary, transcript: (k.transcript || '').slice(0, 20_000),
      duration_s: k.duration_s, created_at: k.created_at, late: k.source === 'recovered',
    }));
    res.set('Cache-Control', 'no-store');
    res.json({
      shop: { business: c.business, contact: c.contact, phoneNumber: c.phoneNumber, status: c.status, timezone: c.details?.schedule?.timezone || config.timezone,
        country: countryOf(c).code, locale: countryOf(c).locale },
      billing: { provider: billingProvider(config, c), status: c.details?.billing?.status || null },
      usage: await usageOf(c),
      items: items.map(({ id, kind, slot_start, slot_label, caller_name, caller_phone, address, issue, urgency, created_at, done_at, sync_status, sync_error }) => ({ id, kind, slot_start, slot_label, caller_name, caller_phone, address, issue, urgency, created_at, done_at, sync_status, sync_error })),
      calls,
      integration: await integrationView(c.id),
    });
  }));

  // ---- Jobber / Housecall Pro: the owner connects their scheduling tool; new bookings are copied into it.
  async function integrationView(clientId) {
    const row = await db.getIntegration(clientId);
    return {
      connected: row ? { provider: row.provider, name: PROVIDERS[row.provider], account: row.account_name, since: row.created_at } : null,
      jobberAvailable: Boolean(config.jobber.clientId && config.jobber.clientSecret),
    };
  }
  const backToDashboard = (clientId, extra) => {
    const url = ownerUrl(config, { id: clientId });
    return url ? `${url}&${new URLSearchParams(extra)}` : '/';
  };

  app.get('/api/owner/:id/integrations/jobber/start', ownerGate, (req, res) => {
    if (!config.jobber.clientId || !config.jobber.clientSecret) return res.status(501).json({ error: 'Jobber connections are not set up on this server yet.' });
    res.redirect(jobber.authorizeUrl(config, signState(config, req.client.id)));
  });
  app.get('/api/integrations/jobber/callback', async (req, res) => {
    const st = readState(config, req.query.state);
    if (!st) return res.status(400).send('This Jobber sign-in link expired. Go back to your dashboard and press Connect Jobber again.');
    if (req.query.error || !req.query.code) return res.redirect(backToDashboard(st.clientId, { connect_error: 'Jobber access was not granted.' }));
    try {
      const fetchImpl = deps.syncFetch || globalThis.fetch;
      const tokens = await jobber.exchangeCode(config, String(req.query.code), fetchImpl);
      const account = await testConnection(deps, 'jobber', tokens);
      await saveIntegration(deps, st.clientId, 'jobber', tokens, account);
      res.redirect(backToDashboard(st.clientId, { connected: 'jobber' }));
    } catch (e) {
      logger.error(`[jobber] connect failed: ${e.message}`);
      res.redirect(backToDashboard(st.clientId, { connect_error: e.message.slice(0, 200) }));
    }
  });
  app.post('/api/owner/:id/integrations/housecall', ownerGate, wrap(async (req, res) => {
    const apiKey = String(req.body?.apiKey || '').trim();
    if (apiKey.length < 10 || apiKey.length > 300) return res.status(400).json({ error: 'Paste the full API key from Housecall Pro.' });
    let account;
    try { account = await testConnection(deps, 'housecall', { apiKey }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    await saveIntegration(deps, req.client.id, 'housecall', { apiKey }, account);
    res.json({ ok: true, integration: await integrationView(req.client.id) });
  }));
  app.delete('/api/owner/:id/integrations', ownerGate, wrap(async (req, res) => {
    await db.deleteIntegration(req.client.id);
    res.json({ ok: true, integration: await integrationView(req.client.id) });
  }));
  // Start a subscription: Stripe Checkout for US shops, a Razorpay subscription link for Indian shops.
  app.post('/api/owner/:id/billing/checkout', ownerGate, wrap(async (req, res) => {
    const c = req.client, provider = billingProvider(config, c), fetchImpl = deps.syncFetch || globalThis.fetch;
    if (!provider) return res.status(501).json({ error: 'Online payment is not set up yet. We will send you an invoice.' });
    const back = ownerUrl(config, c);
    try {
      if (provider === 'stripe') return res.json({ url: await stripeCheckout(config, c, { successUrl: `${back}&billing=done`, cancelUrl: back, fetchImpl }) });
      const r = await razorpaySubscription(config, c, { fetchImpl });
      await db.updateClient(c.id, { details: { ...c.details, billing: { ...(c.details.billing || {}), provider: 'razorpay', status: 'pending', subscriptionId: r.subscriptionId } } });
      return res.json({ url: r.url });
    } catch (e) { logger.error(`[billing] checkout: ${e.message}`); return res.status(502).json({ error: e.message }); }
  }));
  app.post('/api/owner/:id/items/:itemId/sync', ownerGate, wrap(async (req, res) => {
    if (!(await loadIntegration(deps, req.client.id))) return res.status(409).json({ error: 'Connect Jobber or Housecall Pro first.' });
    const b = await db.getBooking(req.client.id, req.params.itemId);
    if (!b || b.kind !== 'booking') return res.status(404).json({ error: 'That booking was not found.' });
    res.json(await syncBooking(deps, req.client, b.id));
  }));
  app.post('/api/owner/:id/items/:itemId', ownerGate, wrap(async (req, res) => {
    const ok = await db.setBookingDone(req.client.id, req.params.itemId, req.body?.done !== false);
    if (!ok) return res.status(404).json({ error: 'That booking or message was not found.' });
    res.json({ ok: true });
  }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error(`[http] ${err.message}`);
    res.status(err.status || 500).json({ ok: false, errors: { form: 'Something went wrong on our side. Try again.' } });
  });

  return app;
}

export { isAuthorized };
