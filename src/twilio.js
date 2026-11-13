// Twilio numbers, for when Vapi's free numbers run out (Vapi gives 10 per account). We buy a local
// number in the shop's area code, then import it into Vapi so it answers with the shop's assistant.
const API = 'https://api.twilio.com/2010-04-01';

export function createTwilio({ accountSid, authToken, fetchImpl = globalThis.fetch }) {
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  async function call(method, path, form) {
    const res = await fetchImpl(`${API}/Accounts/${encodeURIComponent(accountSid)}${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (method === 'DELETE' && res.status === 204) return {};
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${method} ${path.split('?')[0]} failed (${res.status}): ${j.message || 'unknown error'}`);
    return j;
  }
  return {
    // A local number in a country: in the area code when one is free there (US, Canada), otherwise anywhere
    // in the country. UK and Australian numbers need an approved regulatory bundle (and address) on file.
    async buyNumber({ country = 'US', areaCode, friendlyName, bundleSid, addressSid }) {
      const search = async (q) => (await call('GET', `/AvailablePhoneNumbers/${country}/Local.json?${new URLSearchParams({ VoiceEnabled: 'true', PageSize: '1', ...q })}`)).available_phone_numbers?.[0]?.phone_number;
      const number = (areaCode && await search({ AreaCode: areaCode })) || await search({});
      if (!number) throw new Error(`Twilio has no local numbers available in ${country} right now.`);
      const bought = await call('POST', '/IncomingPhoneNumbers.json', { PhoneNumber: number, FriendlyName: friendlyName.slice(0, 64),
        ...(bundleSid ? { BundleSid: bundleSid } : {}), ...(addressSid ? { AddressSid: addressSid } : {}) });
      return { sid: bought.sid, number: bought.phone_number || number };
    },
    buyUsNumber(opts) { return this.buyNumber({ ...opts, country: 'US' }); },
    release: (sid) => call('DELETE', `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
  };
}
