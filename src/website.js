// Reads a shop's public website so a demo receptionist can learn its services and service area.
// The URL comes from the admin, but it is still fetched carefully: public http(s) addresses only,
// no redirects into private networks, a time limit, and a size cap.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 400_000;
const MAX_TEXT = 4000;

function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export class WebsiteError extends Error {}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new WebsiteError('Enter the shop\'s website address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new WebsiteError('That website address doesn\'t look right.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new WebsiteError('Only http and https websites can be read.');
  if (u.username || u.password) throw new WebsiteError('Website addresses with a username or password can\'t be used.');
  return u;
}

async function assertPublic(u, lookup) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new WebsiteError('That address is not a public website.');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new WebsiteError('Couldn\'t find that website. Check the address.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new WebsiteError('That address is not a public website.');
}

// Visible text of a page: title and description first, then the body without scripts, styles or menus.
export function extractText(html) {
  const pick = (re) => (re.exec(html)?.[1] || '').trim();
  const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  const title = decode(pick(/<title[^>]*>([\s\S]*?)<\/title>/i));
  const desc = decode(pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i));
  const body = decode(html
    .replace(/<(script|style|noscript|svg|nav|footer|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, '. ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').trim();
  return [title, desc, body].filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

export async function readWebsite(input, { fetchImpl = globalThis.fetch, lookup = dnsLookup, timeoutMs = 10_000 } = {}) {
  let u = normalizeUrl(input);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u, lookup);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(u.toString(), { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'AfterHoursDesk-DemoBuilder/1.0', Accept: 'text/html' } });
    } catch {
      clearTimeout(timer);
      throw new WebsiteError('Couldn\'t reach that website. Check the address, or try again in a minute.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      u = new URL(res.headers.get('location'), u);
      if (!['http:', 'https:'].includes(u.protocol)) throw new WebsiteError('That website redirects somewhere that can\'t be read.');
      continue;
    }
    if (!res.ok) { clearTimeout(timer); throw new WebsiteError(`That website answered with an error (${res.status}).`); }
    // Read at most MAX_BYTES so a huge page can't tie up the server.
    let html = '';
    try {
      const reader = res.body?.getReader?.();
      if (reader) {
        const dec = new TextDecoder();
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length; html += dec.decode(value, { stream: true });
          if (got > MAX_BYTES) { reader.cancel().catch(() => {}); break; }
        }
      } else {
        html = (await res.text()).slice(0, MAX_BYTES);
      }
    } finally { clearTimeout(timer); }
    const text = extractText(html);
    if (text.length < 40) throw new WebsiteError('That website has almost no readable text. Add the shop\'s services in the notes instead.');
    return { url: u.toString(), text };
  }
  throw new WebsiteError('That website redirects too many times.');
}
