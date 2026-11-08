// The shop owner's private dashboard link. The key is derived from the server secret, so there is
// nothing extra to store, and a key for one shop never opens another.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function ownerKey(config, clientId) {
  return createHmac('sha256', config.webhookSecret).update(`owner:${clientId}`).digest('base64url').slice(0, 32);
}

export function ownerUrl(config, client) {
  if (!config.webhookSecret || !config.publicUrl || !client?.id) return '';
  return `${config.publicUrl}/my/${encodeURIComponent(client.id)}?key=${ownerKey(config, client.id)}`;
}

export function ownerKeyValid(config, clientId, key) {
  if (!config.webhookSecret || typeof key !== 'string' || !clientId) return false;
  const want = Buffer.from(ownerKey(config, clientId)), got = Buffer.from(key);
  return want.length === got.length && timingSafeEqual(want, got);
}
