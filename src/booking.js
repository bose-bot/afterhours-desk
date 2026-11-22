// Each shop's public booking page: /b/<slug>. Customers pick an open window and book a visit without
// calling. Same windows, capacity and days off as the phone receptionist, same emails and texts after.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSlots } from './scheduling.js';
import { countryOf } from './countries.js';
import { tradeOf } from './trades.js';
import { normalizePhone, prettyPhone } from './phone.js';
import { callSummaryEmail } from './emails.js';
import { syncBooking } from './integrations/sync.js';
import { notify } from './notify.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const str = (v, n = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, n);
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'shop';

/** The shop's booking-page slug, created (and kept unique) the first time it is needed. */
export async function ensureSlug(db, client) {
  if (client.details?.bookingSlug) return client;
  const taken = new Set((await db.listClients()).map((c) => c.details?.bookingSlug).filter(Boolean));
  const base = slugify(client.business);
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return db.updateClient(client.id, { details: { ...client.details, bookingSlug: slug } });
}
export const bookingUrl = (config, client) => (client.details?.bookingSlug ? `${config.publicUrl}/b/${client.details.bookingSlug}` : '');
export const bookingOn = (client) => client.status === 'active' && client.details?.onlineBooking !== false;

function limiter(perHour) {
  const hits = new Map();
  return (ip) => {
    const t = Date.now(), list = (hits.get(ip) || []).filter((x) => x > t - 3_600_000);
    if (list.length >= perHour) return false;
    list.push(t); hits.set(ip, list); if (hits.size > 10_000) hits.clear();
    return true;
  };
}

export function registerBookingPage(app, deps) {
  const { db, config, mailer, logger = console } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const allow = limiter(config.bookingsPerIpPerHour || 10);
  const later = (fn) => (deps.runInBackground ? deps.runInBackground(fn) : fn().catch(() => {}));
  const find = async (slug) => {
    const s = str(slug, 60).toLowerCase();
    const c = s ? (await db.listClients()).find((x) => x.details?.bookingSlug === s) : null;
    return c && bookingOn(c) ? c : null;
  };
  const slotsFor = async (c, limit) => openSlots(c.details.schedule, { now: now(), booked: await db.bookedSlotStarts(c.id), daysAhead: 14, limit });

  app.get('/b/:slug', (_req, res) => {
    res.set({ 'Cache-Control': 'no-store' });
    res.sendFile(join(PUBLIC_DIR, 'book.html'));
  });

  app.get('/api/book/:slug', async (req, res, next) => {
    try {
      const c = await find(req.params.slug);
      if (!c) return res.status(404).json({ error: 'This booking page is not available. Please call the business instead.' });
      const C = countryOf(c), T = tradeOf(c, C), d = c.details;
      res.set('Cache-Control', 'no-store');
      res.json({
        business: c.business, phone: prettyPhone(c.phoneNumber) || '', phoneE164: c.phoneNumber || '',
        trade: T.code === 'other' ? (d.businessType || '') : T.label.replace(/\s*\(.*\)/, ''), services: d.services || T.defaultServices, area: d.area || '',
        fee: d.fee || '', bookWhat: T.bookWhat, needsAddress: !T.noAddress, country: C.code, locale: C.locale,
        timezone: d.schedule?.timezone, phoneExample: { US: '(513) 555-0142', CA: '(416) 555-0142', GB: '07700 900123', AU: '0412 345 678', AE: '050 123 4567', SA: '050 123 4567', IN: '98765 43210' }[C.code],
        slots: await slotsFor(c, 40),
      });
    } catch (e) { next(e); }
  });

  app.post('/api/book/:slug', async (req, res, next) => {
    try {
      const b = req.body || {};
      if (b.website) return res.json({ booked: true, window: '' }); // honeypot
      if (!allow(req.ip)) return res.status(429).json({ error: 'Too many bookings from this network. Please call instead.' });
      const c = await find(req.params.slug);
      if (!c) return res.status(404).json({ error: 'This booking page is not available. Please call the business instead.' });
      const C = countryOf(c), T = tradeOf(c, C), errors = {};
      const name = str(b.name, 120), phone = normalizePhone(str(b.phone, 40), C.code), address = str(b.address, 300), issue = str(b.issue, 500);
      if (name.length < 2) errors.name = 'Enter your name.';
      if (!phone) errors.phone = 'Enter a phone number we can reach you on.';
      if (!T.noAddress && address.length < 5) errors.address = 'Enter the address for the visit.';
      if (issue.length < 3) errors.issue = 'Tell us briefly what you need.';
      if (Object.keys(errors).length) return res.status(400).json({ errors });
      const slot = (await slotsFor(c, 400)).find((s) => s.slot_start === str(b.slot_start, 40));
      if (!slot) return res.status(409).json({ error: 'That time was just taken. Please pick another.', slots: await slotsFor(c, 40) });
      const saved = await db.addBooking({ clientId: c.id, kind: 'booking', slotStart: slot.slot_start, slotLabel: slot.label, callerName: name, callerPhone: phone,
        address, issue: `${issue} (booked online)`, urgency: 'Routine', callId: null, capacity: c.details.schedule.capacity });
      if (!saved) return res.status(409).json({ error: 'That time was just taken. Please pick another.', slots: await slotsFor(c, 40) });
      later(() => syncBooking(deps, c, saved.id));
      later(() => notify(deps, c, 'booked', { booking: { slot_label: slot.label, caller_name: name, caller_phone: phone, issue, address } }));
      later(async () => {
        try {
          await mailer.send(callSummaryEmail(config, c, { items: [{ kind: 'booking', slot_label: slot.label, caller_name: name, caller_phone: phone, address, issue, urgency: 'Routine' }],
            callerPhone: phone, summary: 'Booked online through your booking page.' }));
        } catch (e) { logger.error(`[book] email: ${e.message}`); }
      });
      res.json({ booked: true, window: slot.label });
    } catch (e) { next(e); }
  });
}
