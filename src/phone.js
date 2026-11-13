// Phone numbers for every country we serve: cleaning what people type, and printing numbers back.
// Parsing uses libphonenumber (Google's numbering data), so new countries need no new rules here.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// "(513) 555-0142" → "+15135550142", "098765 43210" (IN) → "+919876543210", "020 7946 0958" (GB) → "+442079460958".
// A number typed with + is read as international whatever the country. Returns '' when it can't be a number.
// Uses "possible" (right length for the country) rather than "valid", so test ranges like 555 still pass.
export function normalizePhone(input, country = 'US') {
  const s = str(input);
  if (!s || s.replace(/\D/g, '').length < 6) return '';
  const p = parsePhoneNumberFromString(s, s.startsWith('+') ? undefined : country);
  return p && p.isPossible() ? p.number : '';
}

// How a number is shown: (513) 555-0142 in the US and Canada, international format elsewhere.
export function prettyPhone(e164) {
  if (!e164) return '';
  const p = parsePhoneNumberFromString(e164);
  if (!p) return e164;
  return p.countryCallingCode === '1' ? p.formatNational() : p.formatInternational();
}

export const countryOfPhone = (e164) => parsePhoneNumberFromString(e164 || '')?.country || '';

export function usAreaCode(e164) {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164 || '');
  return m ? m[1] : '';
}
