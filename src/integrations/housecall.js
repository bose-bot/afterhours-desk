// Housecall Pro: the owner pastes an API key (Housecall Pro offers the public API on its MAX plan).
// Each booking becomes a customer (found by phone, or created) and a scheduled job.
export const HCP_API = 'https://api.housecallpro.com';

async function hcp(fetchImpl, apiKey, method, path, body) {
  const res = await fetchImpl(`${HCP_API}${path}`, {
    method,
    headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) { const e = new Error('Housecall Pro did not accept the API key. Check it, and that your plan includes API access.'); e.auth = true; throw e; }
  if (!res.ok) throw new Error(`Housecall Pro said (${res.status}): ${j.message || j.error || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

export async function accountName(fetchImpl, apiKey) {
  const j = await hcp(fetchImpl, apiKey, 'GET', '/company');
  return j.name || j.company?.name || 'Housecall Pro';
}

const split = (full) => { const p = String(full || '').trim().split(/\s+/).filter(Boolean); return { first_name: p[0] || 'Caller', last_name: p.slice(1).join(' ') || '(from AI receptionist)' }; };

export async function createBooking(fetchImpl, apiKey, b, { windowHours = 2 } = {}) {
  let customer = null;
  if (b.caller_phone) {
    try { customer = (await hcp(fetchImpl, apiKey, 'GET', `/customers?q=${encodeURIComponent(b.caller_phone)}&page_size=1`)).customers?.[0] || null; }
    catch (e) { if (e.auth) throw e; }
  }
  let addressId = null;
  if (!customer) {
    customer = await hcp(fetchImpl, apiKey, 'POST', '/customers', {
      ...split(b.caller_name), mobile_number: b.caller_phone || undefined, lead_source: 'AfterHours Desk',
      ...(b.address ? { addresses: [{ street: b.address, type: 'service' }] } : {}),
    });
    addressId = customer.addresses?.[0]?.id || null;
  } else if (b.address) {
    addressId = (await hcp(fetchImpl, apiKey, 'POST', `/customers/${encodeURIComponent(customer.id)}/addresses`, { street: b.address, type: 'service' })).id || null;
  }
  if (!customer?.id) throw new Error('Housecall Pro did not return the customer.');
  const start = new Date(b.slot_start), end = new Date(start.getTime() + windowHours * 3_600_000);
  const job = await hcp(fetchImpl, apiKey, 'POST', '/jobs', {
    customer_id: customer.id, ...(addressId ? { address_id: addressId } : {}),
    schedule: { scheduled_start: start.toISOString(), scheduled_end: end.toISOString(), arrival_window: 0 },
    lead_source: 'AfterHours Desk', tags: ['AfterHours Desk'],
  });
  if (!job.id) throw new Error('Housecall Pro did not return the job.');
  // The problem description goes in as a job note. If notes fail, the job still counts as synced.
  try { await hcp(fetchImpl, apiKey, 'POST', `/jobs/${encodeURIComponent(job.id)}/notes`, { content: `${b.issue || ''}\nCaller: ${b.caller_name || ''} ${b.caller_phone || ''}\nBooked by AfterHours Desk${b.urgency ? ` (${b.urgency})` : ''}` }); } catch { /* optional */ }
  return job.id;
}
