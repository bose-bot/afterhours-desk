// Jobber: OAuth sign-in, then each booking becomes a client (found by phone, or created), a property
// for the address, and a request whose title carries the window the caller chose.
// API reference: https://developer.getjobber.com/docs (GraphQL, OAuth 2.0, tokens last 60 minutes).
export const JOBBER_API = 'https://api.getjobber.com/api';
export const JOBBER_VERSION = '2025-04-16';

export function authorizeUrl(config, state) {
  const q = new URLSearchParams({ response_type: 'code', client_id: config.jobber.clientId, redirect_uri: callbackUrl(config), state });
  return `${JOBBER_API}/oauth/authorize?${q}`;
}
export const callbackUrl = (config) => `${config.publicUrl}/api/integrations/jobber/callback`;

async function tokenRequest(config, params, fetchImpl) {
  const res = await fetchImpl(`${JOBBER_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.jobber.clientId, client_secret: config.jobber.clientSecret, ...params }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Jobber sign-in failed (${res.status}): ${j.error_description || j.error || 'no access token returned'}`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + ((Number(j.expires_in) || 3600) - 60) * 1000 };
}
export const exchangeCode = (config, code, fetchImpl) => tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(config) }, fetchImpl);
export const refreshTokens = (config, refreshToken, fetchImpl) => tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);

export async function gql(fetchImpl, token, query, variables = {}) {
  const res = await fetchImpl(`${JOBBER_API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) { const e = new Error('Jobber connection expired. Reconnect Jobber from your dashboard.'); e.auth = true; throw e; }
  if (!res.ok || j.errors?.length) throw new Error(`Jobber said: ${j.errors?.map((e) => e.message).join('; ') || res.status}`);
  return j.data;
}
// Mutations return userErrors instead of failing; turn those into errors too.
function payload(data, field) {
  const p = data?.[field];
  if (p?.userErrors?.length) throw new Error(`Jobber said: ${p.userErrors.map((e) => e.message).join('; ')}`);
  return p;
}

export async function accountName(fetchImpl, token) {
  const d = await gql(fetchImpl, token, 'query { account { name } }');
  return d?.account?.name || 'Jobber';
}

const splitName = (full) => { const p = String(full || '').trim().split(/\s+/).filter(Boolean); return { firstName: p[0] || 'Caller', lastName: p.slice(1).join(' ') || '(from AI receptionist)' }; };

export async function createBooking(fetchImpl, token, b) {
  // Reuse the client if Jobber already has this phone number, so repeat callers don't get duplicates.
  let clientId = null;
  if (b.caller_phone) {
    try {
      const found = await gql(fetchImpl, token, 'query Find($q: String!) { clients(searchTerm: $q, first: 1) { nodes { id } } }', { q: b.caller_phone });
      clientId = found?.clients?.nodes?.[0]?.id || null;
    } catch { /* search is a nice-to-have; fall through and create */ }
  }
  if (!clientId) {
    const d = await gql(fetchImpl, token, `mutation NewClient($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } userErrors { message } } }`,
      { input: { ...splitName(b.caller_name), ...(b.caller_phone ? { phones: [{ number: b.caller_phone, primary: true, description: 'MAIN' }] } : {}) } });
    clientId = payload(d, 'clientCreate')?.client?.id;
    if (!clientId) throw new Error('Jobber did not return the new client.');
  }
  let propertyId = null;
  if (b.address) {
    const d = await gql(fetchImpl, token, `mutation NewProperty($clientId: EncodedId!, $input: PropertyCreateInput!) { propertyCreate(clientId: $clientId, input: $input) { properties { id } userErrors { message } } }`,
      { clientId, input: { properties: [{ address: { street1: b.address } }] } });
    propertyId = payload(d, 'propertyCreate')?.properties?.[0]?.id || null;
  }
  const title = `${b.slot_label ? `${b.slot_label}: ` : ''}${b.issue || 'Service visit'} (booked by AI receptionist)`.slice(0, 250);
  const d = await gql(fetchImpl, token, `mutation NewRequest($input: RequestCreateInput!) { requestCreate(input: $input) { request { id } userErrors { message } } }`,
    { input: { clientId, title, ...(propertyId ? { propertyId } : {}) } });
  const id = payload(d, 'requestCreate')?.request?.id;
  if (!id) throw new Error('Jobber did not return the new request.');
  return id;
}
