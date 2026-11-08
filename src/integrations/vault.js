// Encrypts each shop's Jobber tokens or Housecall Pro key before they touch the database.
// The key is derived from the server secret, so a database leak alone doesn't expose them.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const keyFor = (config) => createHash('sha256').update(`integrations:${config.webhookSecret}`).digest();

export function seal(config, obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(config), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function unseal(config, text) {
  try {
    const raw = Buffer.from(text, 'base64url');
    const d = createDecipheriv('aes-256-gcm', keyFor(config), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; } // wrong secret or tampered: treat as not connected
}

// Signed, short-lived "state" for the Jobber sign-in round trip: names the shop and can't be forged.
export function signState(config, clientId, now = Date.now()) {
  const body = `${clientId}.${now}.${randomBytes(6).toString('base64url')}`;
  return `${body}.${createHmac('sha256', config.webhookSecret).update(`state:${body}`).digest('base64url').slice(0, 24)}`;
}
export function readState(config, state, now = Date.now(), maxAgeMs = 20 * 60_000) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join('.');
  const want = Buffer.from(createHmac('sha256', config.webhookSecret).update(`state:${body}`).digest('base64url').slice(0, 24));
  const got = Buffer.from(parts[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (now - Number(parts[1]) > maxAgeMs) return null;
  return { clientId: parts[0] };
}
