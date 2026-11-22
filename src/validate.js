// Checks and cleans a sign-up submission. Returns { ok: true, value } or { ok: false, errors }.

const DAY_SETS = {
  'mon-fri': [1, 2, 3, 4, 5],
  'mon-sat': [1, 2, 3, 4, 5, 6],
  'every-day': [0, 1, 2, 3, 4, 5, 6],
  'sun-thu': [0, 1, 2, 3, 4],      // Saudi Arabia's work week
  'sat-thu': [0, 1, 2, 3, 4, 6],
};

import { normalizePhone as toE164, usAreaCode, countryOfPhone } from './phone.js';
import { COUNTRIES } from './countries.js';
import { TRADES } from './trades.js';

// What a full number looks like in each country, for error messages.
const EXAMPLE = { US: '(513) 555-0142', CA: '(416) 555-0142', GB: '07700 900123', AU: '0412 345 678', AE: '050 123 4567', SA: '050 123 4567', IN: '98765 43210' };

const LIMITS = {
  business: 80, contact: 80, email: 120, phone: 30, area: 300, hours: 120, office: 30, oncall: 30, gasline: 30,
  fee: 120, afterfee: 120, services: 400, notes: 1500, calendar: 60, plan: 40, businessType: 80,
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// Kept for older imports: US by default.
export const normalizePhone = (input, country = 'US') => toE164(input, country);

function timeOk(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

export function validateSignup(body, { defaultAreaCode = '', timezone = 'America/New_York' } = {}) {
  const b = body || {};
  const errors = {};
  const v = {};

  for (const [key, max] of Object.entries(LIMITS)) {
    const val = str(b[key]);
    if (val.length > max) errors[key] = `Keep this under ${max} characters.`;
    v[key] = val.slice(0, max);
  }

  if (!v.business) errors.business = 'Enter your business name.';
  if (!v.contact) errors.contact = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid email address.';
  v.email = v.email.toLowerCase();

  // The kind of business: HVAC unless another trade was picked. "Other" says what it does in a few words.
  v.trade = TRADES[str(b.trade).toLowerCase()] ? str(b.trade).toLowerCase() : 'hvac';
  if (v.trade === 'other' && !v.businessType) errors.businessType = 'Tell us what your business does, like "dental clinic" or "auto repair shop".';
  if (v.trade !== 'other') delete v.businessType;

  // The country the shop picked, or the one its +number belongs to, or the US.
  const picked = str(b.country).toUpperCase();
  const fromPhone = str(b.phone).startsWith('+') ? countryOfPhone(toE164(b.phone)) : '';
  v.country = COUNTRIES[picked] ? picked : (COUNTRIES[fromPhone] ? fromPhone : 'US');
  const C = COUNTRIES[v.country];
  const lang = C.languages.find((l) => l.code === str(b.language)) || C.languages[0];
  if (lang) v.language = lang.code; else delete v.language;

  v.phone = normalizePhone(b.phone, v.country);
  if (!v.phone) errors.phone = v.country === 'US' ? 'Enter a mobile number we can text, like (513) 555-0142.' : `Enter a full mobile number, like ${EXAMPLE[v.country]}.`;

  for (const key of ['office', 'oncall', 'gasline']) {
    if (v[key]) {
      const n = normalizePhone(v[key], v.country);
      if (!n) errors[key] = v.country === 'US' ? 'Enter a full phone number with area code.' : `Enter a full phone number, like ${EXAMPLE[v.country]}.`;
      else v[key] = n;
    }
  }
  if (v.country === 'US') delete v.gasline; // 911 and the gas company cover the US

  const days = DAY_SETS[str(b.workDays)] || DAY_SETS['mon-fri'];
  const dayStart = timeOk(str(b.dayStart)) ? str(b.dayStart) : '08:00';
  const dayEnd = timeOk(str(b.dayEnd)) ? str(b.dayEnd) : '17:00';
  if (dayEnd <= dayStart) errors.dayEnd = 'Closing time must be after opening time.';
  const tzGiven = str(b.timezone);
  const tz = C.timezones.some(([z]) => z === tzGiven) ? tzGiven : (v.country === 'US' ? (tzGiven || timezone) : C.timezone);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.timezone = 'Unknown time zone.'; }
  v.schedule = { days, start: dayStart, end: dayEnd, windowHours: 2, timezone: tz };

  const area = str(b.areaCode);
  // Area codes pick a local number in the US and Canada (both +1).
  v.areaCode = C.areaCodes ? (/^\d{3}$/.test(area) ? area : (usAreaCode(v.phone) || (v.country === 'US' ? defaultAreaCode : '') || '')) : '';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v };
}

/**
 * Checks the settings an owner changes from their dashboard. Only these fields can change; anything
 * else in the body is ignored. Returns { ok, value: details-to-merge } or { ok: false, errors }.
 */
export function validateSettings(body, client) {
  const b = body || {}, d = client.details || {}, errors = {}, v = {};
  const C = COUNTRIES[d.country] || COUNTRIES.US;
  const text = { area: 300, services: 400, fee: 120, afterfee: 120, notes: 1500, businessType: 80, reviewUrl: 300 };
  for (const [k, max] of Object.entries(text)) {
    if (!(k in b)) continue;
    const val = str(b[k]);
    if (val.length > max) errors[k] = `Keep this under ${max} characters.`;
    v[k] = val.slice(0, max);
  }
  if ('reviewUrl' in v && v.reviewUrl && !/^https:\/\/\S+$/.test(v.reviewUrl)) errors.reviewUrl = 'Paste the full review link, starting with https://';
  if (v.businessType !== undefined && d.trade !== 'other') delete v.businessType;

  for (const k of ['office', 'oncall', 'gasline', 'alertPhone']) {
    if (!(k in b)) continue;
    const raw = str(b[k]);
    if (!raw) { v[k] = ''; continue; }
    const n = normalizePhone(raw, d.country || 'US');
    if (!n) errors[k] = `Enter a full phone number, like ${EXAMPLE[d.country || 'US']}.`; else v[k] = n;
  }

  // Hours, jobs per window and window length all live in the schedule.
  const s = { ...(d.schedule || {}) };
  if ('workDays' in b) { if (DAY_SETS[str(b.workDays)]) s.days = DAY_SETS[str(b.workDays)]; else errors.workDays = 'Pick working days.'; }
  if ('dayStart' in b) { if (timeOk(str(b.dayStart))) s.start = str(b.dayStart); else errors.dayStart = 'Use a time like 08:00.'; }
  if ('dayEnd' in b) { if (timeOk(str(b.dayEnd))) s.end = str(b.dayEnd); else errors.dayEnd = 'Use a time like 17:00.'; }
  if (s.start && s.end && s.end <= s.start) errors.dayEnd = 'Closing time must be after opening time.';
  if ('capacity' in b) { const n = Number(b.capacity); if (Number.isInteger(n) && n >= 1 && n <= 20) s.capacity = n; else errors.capacity = 'Between 1 and 20 jobs.'; }
  if ('windowHours' in b) { const n = Number(b.windowHours); if ([1, 2, 3, 4].includes(n)) s.windowHours = n; else errors.windowHours = 'Pick 1, 2, 3 or 4 hours.'; }
  if ('closed' in b) {
    const list = Array.isArray(b.closed) ? b.closed : [];
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const clean = [];
    for (const c of list.slice(0, 60)) {
      const from = str(c?.from), to = str(c?.to) || from;
      if (!ymd.test(from) || !ymd.test(to) || to < from) { errors.closed = 'Each day off needs a start date, and an end date on or after it.'; break; }
      if (to >= today) clean.push({ from, to, note: str(c?.note).slice(0, 80) });
    }
    s.closed = clean.sort((a, z) => a.from.localeCompare(z.from));
  }
  v.schedule = s;

  if ('avgJob' in b) { const raw = str(b.avgJob).replace(/[^\d.]/g, ''); const n = raw ? Number(raw) : 0; if (Number.isFinite(n) && n >= 0 && n <= 1_000_000) v.avgJob = n || ''; else errors.avgJob = 'Enter a number, like 350.'; }
  if ('smsAlerts' in b) { if (['all', 'urgent', 'off'].includes(str(b.smsAlerts))) v.smsAlerts = str(b.smsAlerts); else errors.smsAlerts = 'Pick when to text you.'; }
  for (const k of ['textCallers', 'textBack', 'onlineBooking', 'quoteFollowUp']) if (k in b) v[k] = b[k] === true || b[k] === 'true' || b[k] === 'on';
  if ('language' in b) { const l = C.languages.find((x) => x.code === str(b.language)); if (l) v.language = l.code; else if (C.languages.length) errors.language = 'Pick a language.'; }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v };
}
