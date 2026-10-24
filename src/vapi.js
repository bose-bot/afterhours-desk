// Small client for the parts of the Vapi API this app uses.

export class VapiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VapiError';
    this.status = status;
  }
}

export function createVapiClient({ apiKey, baseUrl = 'https://api.vapi.ai', fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  async function call(method, path, body) {
    // Without a limit, a hung connection would leave a client stuck in "setting up" forever.
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    let res, text;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (e) {
      const why = timedOut ? `no answer after ${Math.round(timeoutMs / 1000)}s` : e?.message || 'network error';
      throw new VapiError(`Vapi ${method} ${path} failed: ${why}`, 0);
    } finally {
      clearTimeout(timer);
    }
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
