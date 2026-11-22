// Features that bring the shop more work and show what the receptionist earned them:
// the monthly results report, quote follow-up texts, and tune-up campaigns to past customers.
import { zonedParts, zonedToUtc, isClosed } from './scheduling.js';
import { countryOf } from './countries.js';
import { tradeOf } from './trades.js';
import { normalizePhone, prettyPhone } from './phone.js';
import { ownerUrl } from './owner.js';
import { bookingUrl, bookingOn, ensureSlug } from './booking.js';
import { smsReady } from './notify.js';
import { createTwilio } from './twilio.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

// ---- Results

function monthRange(tz, y, m) {
  const start = zonedToUtc(y, m, 1, 0, 0, tz);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { start, end: zonedToUtc(ny, nm, 1, 0, 0, tz), key: `${y}-${pad(m)}` };
}

// A call is "after hours or busy" when it came outside working hours, on a day off, or on a closed day.
// (Calls inside hours reach the receptionist only when the team didn't pick up, so all calls count as saved.)
function outsideHours(iso, schedule) {
  const tz = schedule.timezone || 'America/New_York', p = zonedParts(new Date(iso), tz);
  const hm = `${pad(p.h)}:${pad(p.min)}`;
  return !schedule.days?.includes(p.weekday) || isClosed(schedule, `${p.y}-${pad(p.m)}-${pad(p.d)}`) || hm < (schedule.start || '08:00') || hm >= (schedule.end || '17:00');
}

export function monthResults(client, calls, bookings, { start, end }) {
  const inRange = (iso) => { const t = Date.parse(iso); return t >= start.getTime() && t < end.getTime(); };
  const c = calls.filter((x) => inRange(x.started_at || x.created_at));
  const booked = bookings.filter((b) => b.kind === 'booking' && inRange(b.created_at)).length;
  const messages = bookings.filter((b) => b.kind === 'message' && inRange(b.created_at)).length;
  const avg = Number(client.details?.avgJob) || 0;
  return {
    calls: c.length,
    afterHours: c.filter((x) => outsideHours(x.started_at || x.created_at, client.details.schedule || {})).length,
    booked, messages,
    minutes: Math.round(c.reduce((n, x) => n + (x.duration_s || 0), 0) / 60),
    value: avg ? Math.round(avg * booked) : 0,
  };
}

export function resultsView(client, calls, bookings, now = new Date()) {
  const tz = client.details?.schedule?.timezone || 'America/New_York', C = countryOf(client), p = zonedParts(now, tz);
  const cur = monthRange(tz, p.y, p.m), prev = monthRange(tz, p.m === 1 ? p.y - 1 : p.y, p.m === 1 ? 12 : p.m - 1);
  const label = new Intl.DateTimeFormat(C.locale || 'en-US', { month: 'long', year: 'numeric', timeZone: tz }).format(cur.start);
  const last = monthResults(client, calls, bookings, prev);
  return { label, currency: C.currency || 'USD', thisMonth: monthResults(client, calls, bookings, cur), lastMonth: last.calls || last.booked ? last : null };
}

export function monthlyResultsEmail(config, client, r, monthLabel) {
  const C = countryOf(client), money = (n) => new Intl.NumberFormat(C.locale || 'en-US', { style: 'currency', currency: C.currency || 'USD', maximumFractionDigits: 0 }).format(n);
  const dash = ownerUrl(config, client);
  const lines = [
    `${r.calls} ${r.calls === 1 ? 'call' : 'calls'} answered`,
    `${r.afterHours} of them after hours, on days off or while you were busy`,
    `${r.booked} ${r.booked === 1 ? 'job' : 'jobs'} booked and ${r.messages} ${r.messages === 1 ? 'message' : 'messages'} taken`,
    r.value ? `About ${money(r.value)} in booked work, at your average job value` : 'Add your average job value in Settings to see what that work is worth',
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return {
    to: client.email,
    subject: `${monthLabel}: ${r.calls} ${r.calls === 1 ? 'call' : 'calls'} answered, ${r.booked} ${r.booked === 1 ? 'job' : 'jobs'} booked${r.value ? `, about ${money(r.value)}` : ''}`,
    text: `Hi ${client.contact},\n\nHere's what your receptionist did for ${client.business} in ${monthLabel}:\n\n${lines.map((l) => `• ${l}`).join('\n')}\n${dash ? `\nSee every call and booking: ${dash}\n` : ''}\n${config.brandName}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0E1A22">
<p style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#E2661A;margin:0">${esc(monthLabel)} results</p>
<h1 style="font-size:26px;margin:6px 0 18px">${esc(client.business)}</h1>
<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px"><tr>
${[[r.calls, r.calls === 1 ? 'call answered' : 'calls answered'], [r.booked, r.booked === 1 ? 'job booked' : 'jobs booked'], [r.value ? money(r.value) : '—', 'booked work']].map(([n, l]) => `<td style="background:#F1F4F7;border-radius:12px;padding:14px;text-align:center"><div style="font-size:26px;font-weight:800">${esc(n)}</div><div style="font-size:13px;color:#506270">${esc(l)}</div></td>`).join('')}
</tr></table>
<p style="font-size:15px;color:#33434F">${esc(lines[1])}. ${esc(lines[2])}.</p>
${dash ? `<p><a href="${esc(dash)}" style="display:inline-block;background:#E2661A;color:#fff;text-decoration:none;font-weight:700;border-radius:999px;padding:12px 20px">Open your dashboard</a></p>` : ''}
<p style="font-size:13px;color:#506270">${esc(config.brandName)}</p></div>`,
  };
}

/** Hourly: on the 1st of each month, from 8 AM shop time, each shop gets last month's results once. */
export async function runMonthlyResults(deps) {
  const { db, config, mailer, logger = console, now = () => new Date() } = deps;
  let sent = 0;
  for (const c of await db.listClients()) {
    if (c.status !== 'active') continue;
    const tz = c.details?.schedule?.timezone || 'America/New_York', p = zonedParts(now(), tz);
    if (p.d !== 1 || p.h < 8) continue;
    const prev = monthRange(tz, p.m === 1 ? p.y - 1 : p.y, p.m === 1 ? 12 : p.m - 1);
    const r = monthResults(c, await db.listCalls(c.id), await db.listBookings(c.id), prev);
    if (!r.calls && !r.booked) continue;
    const { created } = await db.getOrCreateSetting(`results:${c.id}:${prev.key}`, () => new Date().toISOString());
    if (!created) continue;
    const label = new Intl.DateTimeFormat(countryOf(c).locale || 'en-US', { month: 'long', year: 'numeric', timeZone: tz }).format(prev.start);
    try { await mailer.send(monthlyResultsEmail(config, c, r, label)); sent++; } catch (e) { logger.error(`[results] ${c.business}: ${e.message}`); }
  }
  return sent;
}

// ---- Texts to customers

async function text(deps, to, body) {
  const { config } = deps;
  return createTwilio({ ...config.twilio, fetchImpl: deps.syncFetch || globalThis.fetch })
    .sendSms({ to, body, from: config.sms.from, messagingServiceSid: config.sms.messagingServiceSid });
}
const howToBook = (config, client) => (bookingOn(client) && bookingUrl(config, client) ? `Book online: ${bookingUrl(config, client)}` : `Call us: ${prettyPhone(client.phoneNumber) || ''}`.trim());

const QUOTE = /\b(quote|estimate|price|pricing|cost|how much|new (system|unit|furnace|ac|boiler|roof|water heater|panel|door)|replace(ment)?|install(ation)?)\b/i;

/** Hourly: 3 days after a caller asked about a price and didn't book, a friendly text to book the estimate visit. */
export async function runQuoteFollowUps(deps) {
  const { db, config, logger = console, now = () => new Date() } = deps;
  if (!smsReady(config)) return 0;
  let sent = 0;
  const t = now().getTime();
  for (let c of await db.listClients()) {
    if (c.status !== 'active' || c.details?.quoteFollowUp === false) continue;
    const all = await db.listBookings(c.id), cc = countryOf(c).code;
    for (const m of all) {
      const age = t - Date.parse(m.created_at);
      if (m.kind !== 'message' || m.done_at || age < 3 * DAY || age > 4 * DAY || !QUOTE.test(m.issue || '')) continue;
      const phone = normalizePhone(m.caller_phone, cc);
      if (!phone) continue;
      const bookedSince = all.some((b) => b.kind === 'booking' && Date.parse(b.created_at) > Date.parse(m.created_at) && normalizePhone(b.caller_phone, cc) === phone);
      if (bookedSince) continue;
      const { created } = await db.getOrCreateSetting(`quote:${c.id}:${m.id}`, () => new Date().toISOString());
      if (!created) continue;
      c = await ensureSlug(db, c);
      const T = tradeOf(c, countryOf(c));
      try {
        await text(deps, phone, `Hi ${String(m.caller_name || '').split(' ')[0] || 'there'}, it's ${c.business}. You asked about a price a few days ago. ${T.code === 'other' ? 'We can' : `A ${T.staff === 'technician' ? 'technician' : T.staff} can`} come out and give you an exact quote. ${howToBook(config, c)}`);
        sent++;
      } catch (e) { logger.error(`[quote] ${c.business}: ${e.message}`); }
    }
  }
  return sent;
}

// ---- Tune-up campaigns

const SEASON = (client, now) => {
  const hemiSouth = ['AU'].includes(countryOf(client).code);
  const m = zonedParts(now, client.details?.schedule?.timezone || 'UTC').m;
  const warmSoon = hemiSouth ? [8, 9, 10, 11].includes(m) : [2, 3, 4, 5].includes(m);
  return warmSoon ? 'summer' : 'winter';
};

/** The default text for the shop's trade and season. {name} is replaced with each customer's first name. */
export function defaultCampaignText(config, client, now = new Date()) {
  const T = tradeOf(client, countryOf(client)), book = howToBook(config, client);
  const season = SEASON(client, now);
  const offer = {
    hvac: season === 'summer' ? 'Beat the first heat wave with an AC tune-up.' : 'Get your heating checked before the first cold night.',
    plumbing: 'Time for a check-up: water heater flush, leaks and drains.',
    electrical: 'Book a safety check: panel, outlets and smoke alarms.',
    roofing: 'Get a roof check before the next storm season.',
    pest: 'Time for your seasonal pest treatment.',
    appliance: 'Book a check-up for your appliances before the holidays.',
    garage: 'Time for a garage door tune-up: springs, cables and opener.',
    locksmith: 'Moved recently or lost a key? Book a rekey.',
    cleaning: 'Time for a seasonal deep clean.',
    landscaping: 'Book your seasonal yard and tree care.',
    other: 'It is a good time to book your next appointment.',
  }[T.code] || 'It is a good time to book your next visit.';
  return `Hi {name}, it's ${client.business}. ${offer} ${book} Reply STOP to opt out.`;
}

/** Past customers to text: everyone who booked, minus anyone texted by a campaign in the last 90 days. */
export async function campaignAudience(db, client) {
  const cc = countryOf(client).code, seen = new Map();
  for (const b of await db.listBookings(client.id)) {
    if (b.kind !== 'booking') continue;
    const phone = normalizePhone(b.caller_phone, cc);
    if (phone && !seen.has(phone)) seen.set(phone, String(b.caller_name || '').split(' ')[0] || 'there');
  }
  const out = [];
  for (const [phone, name] of seen) {
    const last = await db.getSetting(`camp:${client.id}:${phone}`);
    if (!last || Date.now() - Date.parse(last) > 90 * DAY) out.push({ phone, name });
  }
  return out;
}

/** Sends the campaign, one text per customer, and remembers who got it so nobody is texted twice in 90 days. */
export async function sendCampaign(deps, client, message) {
  const { db, logger = console } = deps;
  const people = (await campaignAudience(db, client)).slice(0, 500);
  let sent = 0;
  for (const p of people) {
    try {
      await text(deps, p.phone, message.replace(/\{name\}/g, p.name));
      await db.setSetting(`camp:${client.id}:${p.phone}`, new Date().toISOString());
      sent++;
    } catch (e) { logger.error(`[campaign] ${client.business}: ${e.message}`); }
  }
  return { sent, total: people.length };
}
