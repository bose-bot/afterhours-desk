// Checks and cleans a sign-up submission. Returns { ok: true, value } or { ok: false, errors }.

const DAY_SETS = {
  'mon-fri': [1, 2, 3, 4, 5],
  'mon-sat': [1, 2, 3, 4, 5, 6],
  'every-day': [0, 1, 2, 3, 4, 5, 6],
};

import { normalizePhone as toE164, usAreaCode } from './phone.js';
import { COUNTRIES } from './countries.js';

const LIMITS = {
  business: 80, contact: 80, email: 120, phone: 30, area: 300, hours: 120, office: 30, oncall: 30, gasline: 30,
  fee: 120, afterfee: 120, services: 400, notes: 1500, calendar: 60, plan: 40,
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

  // US unless the shop picked India or typed a +91 number.
  v.country = str(b.country).toUpperCase() === 'IN' || /^\+?\s*91[\s-]?[6-9]/.test(str(b.phone)) && str(b.phone).startsWith('+') ? 'IN' : 'US';
  const C = COUNTRIES[v.country];

  v.phone = normalizePhone(b.phone, v.country);
  if (!v.phone) errors.phone = v.country === 'IN' ? 'Enter a 10-digit mobile number, like 98765 43210.' : 'Enter a mobile number we can text, like (513) 555-0142.';

  for (const key of ['office', 'oncall', 'gasline']) {
    if (v[key]) {
      const n = normalizePhone(v[key], v.country);
      if (!n) errors[key] = v.country === 'IN' ? 'Enter a full phone number, like 98765 43210 or 022 2345 6789.' : 'Enter a full phone number with area code.';
      else v[key] = n;
    }
  }
  if (v.country !== 'IN') delete v.gasline;

  const days = DAY_SETS[str(b.workDays)] || DAY_SETS['mon-fri'];
  const dayStart = timeOk(str(b.dayStart)) ? str(b.dayStart) : '08:00';
  const dayEnd = timeOk(str(b.dayEnd)) ? str(b.dayEnd) : '17:00';
  if (dayEnd <= dayStart) errors.dayEnd = 'Closing time must be after opening time.';
  const tz = str(b.timezone) || (v.country === 'IN' ? C.timezone : timezone);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.timezone = 'Unknown time zone.'; }
  v.schedule = { days, start: dayStart, end: dayEnd, windowHours: 2, timezone: tz };

  const area = str(b.areaCode);
  v.areaCode = v.country === 'US' ? (/^\d{3}$/.test(area) ? area : (usAreaCode(v.phone) || defaultAreaCode || '')) : '';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v };
}
