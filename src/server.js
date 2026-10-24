import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSignup } from './validate.js';
import { provisionClient, refreshNumber } from './provision.js';
import { createWebhookHandler, isAuthorized } from './webhook.js';
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

function publicView(c) {
  return { id: c.id, business: c.business, status: c.status, phoneNumber: c.phoneNumber };
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
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const jobs = new Set();
  const runInBackground = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => logger.error(`[job] ${e.message}`)).finally(() => jobs.delete(p));
    jobs.add(p);
  };
  app.locals.idle = () => Promise.all([...jobs]);

  const allowSignup = rateLimiter(config.signupsPerIpPerHour);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---- Public sign-up ----
  app.post('/api/signup', (req, res) => {
    const body = req.body || {};
    if (body.website) return res.status(202).json({ ok: true }); // honeypot: bots fill hidden fields

    const check = validateSignup(body, { defaultAreaCode: config.vapi.defaultAreaCode, timezone: config.timezone });
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });
    const v = check.value;

    const existing = db.findClientByEmail(v.email);
    if (existing && existing.status !== 'failed') {
      return res.status(409).json({ ok: false, errors: { email: 'This email already has a receptionist. Check your inbox, or reply to our email to make changes.' } });
    }
    if (!allowSignup(req.ip || 'unknown')) {
      return res.status(429).json({ ok: false, errors: { form: 'Too many sign-ups from this network. Try again in an hour.' } });
    }
    if (db.countLiveClients() >= config.maxClients) {
      return res.status(503).json({ ok: false, errors: { form: 'We are at capacity right now. Email us and we will add you to the waitlist.' } });
    }

    const { business, contact, email, phone, ...rest } = v;
    const status = config.provisionMode === 'approval' ? 'pending_approval' : 'provisioning';
    const client = db.createClient({ status, business, contact, email, phone, details: rest });

    if (status === 'provisioning') runInBackground(() => provisionClient(client.id, deps));
    else runInBackground(() => deps.mailer.send({
      to: config.mail.operatorEmail,
      subject: `Approve new sign-up: ${business}`,
      text: `${business} (${contact}, ${email}) signed up.\nApprove: POST ${config.publicUrl}/api/admin/clients/${client.id}/approve`,
    }));

    return res.status(202).json({ ok: true, client: publicView(client) });
  });

  // Lets the sign-up page show the new number as soon as it exists. The id is an unguessable UUID.
  app.get('/api/signup/:id', (req, res) => {
    const c = db.getClient(req.params.id);
    if (!c) return res.status(404).json({ ok: false });
    return res.json({ ok: true, client: publicView(c) });
  });

  // ---- Vapi webhook ----
  app.post('/api/vapi/webhook', createWebhookHandler(deps));

  // ---- Admin (Bearer ADMIN_TOKEN) ----
  const admin = express.Router();
  admin.use((req, res, next) => {
    const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(config.adminToken || '');
    if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  admin.get('/clients', (_req, res) => res.json({ clients: db.listClients() }));
  admin.get('/clients/:id', (req, res) => {
    const c = db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ client: c, bookings: db.listBookings(c.id), calls: db.listCalls(c.id) });
  });
  const startSetup = (allowed) => (req, res) => {
    const c = db.getClient(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (!allowed.includes(c.status)) return res.status(409).json({ error: `Client is ${c.status}.` });
    db.updateClient(c.id, { status: 'provisioning' });
    runInBackground(() => provisionClient(c.id, deps));
    res.status(202).json({ ok: true });
  };
  admin.post('/clients/:id/approve', startSetup(['pending_approval']));
  admin.post('/clients/:id/retry', startSetup(['failed']));
  admin.post('/clients/:id/refresh-number', async (req, res) => {
    try { res.json({ client: await refreshNumber(req.params.id, deps) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.use('/api/admin', admin);

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error(`[http] ${err.message}`);
    res.status(err.status || 500).json({ ok: false, errors: { form: 'Something went wrong on our side. Try again.' } });
  });

  return app;
}

export { isAuthorized };
