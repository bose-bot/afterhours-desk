// Sends a booking to the shop's connected scheduling tool. Never throws: a failed sync is recorded on the
// booking (shown on the dashboard with a Retry button), and the booking itself and the emails are unaffected.
import { seal, unseal } from './vault.js';
import * as jobber from './jobber.js';
import * as housecall from './housecall.js';

export const PROVIDERS = { jobber: 'Jobber', housecall: 'Housecall Pro' };

export async function loadIntegration({ db, config }, clientId) {
  const row = await db.getIntegration(clientId);
  if (!row) return null;
  const secret = unseal(config, row.secret);
  return secret ? { ...row, secret } : null;
}

export async function saveIntegration({ db, config }, clientId, provider, secret, accountName) {
  await db.saveIntegration({ clientId, provider, secret: seal(config, secret), accountName });
}

// A Jobber access token that is good for at least another minute, refreshing (and saving the rotated
// refresh token) when needed.
async function jobberToken(deps, integ, fetchImpl) {
  if (integ.secret.expiresAt > Date.now() + 60_000) return integ.secret.accessToken;
  const fresh = await jobber.refreshTokens(deps.config, integ.secret.refreshToken, fetchImpl);
  const secret = { ...integ.secret, ...fresh, refreshToken: fresh.refreshToken || integ.secret.refreshToken };
  await saveIntegration(deps, integ.client_id, 'jobber', secret, integ.account_name);
  integ.secret = secret;
  return secret.accessToken;
}

export async function syncBooking(deps, client, bookingId) {
  const { db, logger = console } = deps;
  const fetchImpl = deps.syncFetch || globalThis.fetch;
  const integ = await loadIntegration(deps, client.id);
  if (!integ) return { status: 'none' };
  const b = await db.getBooking(client.id, bookingId);
  if (!b || b.kind !== 'booking') return { status: 'none' };
  if (b.sync_status === 'synced') return { status: 'synced', ref: b.sync_ref };
  try {
    const ref = integ.provider === 'jobber'
      ? await jobber.createBooking(fetchImpl, await jobberToken(deps, integ, fetchImpl), b)
      : await housecall.createBooking(fetchImpl, integ.secret.apiKey, b, { windowHours: client.details?.schedule?.windowHours || 2 });
    await db.setBookingSync(b.id, { status: 'synced', ref: String(ref), error: null });
    return { status: 'synced', ref: String(ref) };
  } catch (e) {
    const error = `${e.message}`.slice(0, 300);
    await db.setBookingSync(b.id, { status: 'failed', ref: null, error });
    logger.error(`[sync] ${client.business} → ${PROVIDERS[integ.provider]}: ${error}`);
    return { status: 'failed', error };
  }
}

export async function testConnection(deps, provider, secret) {
  const fetchImpl = deps.syncFetch || globalThis.fetch;
  return provider === 'jobber' ? jobber.accountName(fetchImpl, secret.accessToken) : housecall.accountName(fetchImpl, secret.apiKey);
}
export { jobber, housecall };
