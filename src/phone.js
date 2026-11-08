// Phone numbers for the countries we serve: cleaning what people type, and printing numbers back.

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// "(513) 555-0142" → "+15135550142" (US), "098765 43210" → "+919876543210" (India).
// Anything typed with a leading + is taken as already international. Returns '' when it can't be a number.
export function normalizePhone(input, country = 'US') {
  const s = str(input);
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  if (country === 'IN') {
    const local = digits.replace(/^0+/, '');
    if (local.length === 10) return `+91${local}`;
    if (local.length === 12 && local.startsWith('91')) return `+${local}`;
    return '';
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

// How a number is shown to people: (513) 555-0142 for the US, +91 98765 43210 for India.
export function prettyPhone(e164) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
  const ind = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  if (ind) return `+91 ${ind[1]} ${ind[2]}`;
  return e164 || '';
}

export const countryOfPhone = (e164) => (/^\+91\d{10}$/.test(e164 || '') ? 'IN' : /^\+1\d{10}$/.test(e164 || '') ? 'US' : '');

export function usAreaCode(e164) {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164 || '');
  return m ? m[1] : '';
}
