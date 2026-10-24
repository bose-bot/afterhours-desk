// Small client for the parts of the Vapi API this app uses.

export class VapiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VapiError';
    this.status = status;
  }
}

export function createVapiClient({ apiKey, baseUrl = 'https://api.vapi.ai', fetchImpl = globalThis.fetch }) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const detail = data?.message ? (Array.isArray(data.message) ? data.message.join('; ') : data.message) : text.slice(0, 300);
      throw new VapiError(`Vapi ${method} ${path} failed (${res.status}): ${detail}`, res.status);
    }
    return data;
  }

  return {
    createAssistant: (body) => call('POST', '/assistant', body),
    deleteAssistant: (id) => call('DELETE', `/assistant/${encodeURIComponent(id)}`),
    createPhoneNumber: (body) => call('POST', '/phone-number', body),
    getPhoneNumber: (id) => call('GET', `/phone-number/${encodeURIComponent(id)}`),
  };
}
