// "Build a demo": turn one reusable demo phone number into any prospect's receptionist in about a minute.
// The demo is stored as a client with status 'demo' so its tools, bookings and call summaries all work;
// summaries go to the operator, not the prospect.
import { assistantBody } from './provision.js';
import { readWebsite } from './website.js';

const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', windowHours: 2, timezone: 'America/New_York' };

export async function buildDemo({ business, website, area, notes }, deps) {
  const { db, vapi, config, fetchImpl, lookup } = deps;
  const name = String(business || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('Enter the shop\'s name.'), { status: 400 });

  let site = null;
  if (website) site = await readWebsite(website, { fetchImpl, lookup });

  const details = {
    area: String(area || '').trim().slice(0, 300),
    notes: String(notes || '').trim().slice(0, 1500),
    websiteInfo: site?.text || '',
    websiteUrl: site?.url || '',
    schedule: { ...DEFAULT_SCHEDULE, timezone: config.timezone || DEFAULT_SCHEDULE.timezone },
  };

  // One demo client, reused for every prospect.
  const demoId = await db.getSetting('demo_client_id');
  let client = demoId ? await db.getClient(demoId) : null;
  if (!client) {
    client = await db.createClient({
      status: 'demo', business: name, contact: 'Demo', email: config.mail?.operatorEmail || 'demo@invalid', phone: '+10000000000', details,
    });
    await db.setSetting('demo_client_id', client.id);
  } else {
    client = await db.updateClient(client.id, { business: name, details, email: config.mail?.operatorEmail || client.email });
  }

  const body = assistantBody(config, client);
  if (client.vapiAssistantId) {
    const { name: n, firstMessage, model, server, serverMessages, voice } = body;
    await vapi.updateAssistant(client.vapiAssistantId, { name: n, firstMessage, model, server, serverMessages, ...(voice ? { voice } : {}) });
  } else {
    const a = await vapi.createAssistant(body);
    client = await db.updateClient(client.id, { vapiAssistantId: a.id });
  }

  if (client.vapiPhoneId) {
    await vapi.updatePhoneNumber(client.vapiPhoneId, { assistantId: client.vapiAssistantId, name: `Demo: ${name}`.slice(0, 40) });
  } else {
    const req = { provider: 'vapi', assistantId: client.vapiAssistantId, name: `Demo: ${name}`.slice(0, 40) };
    if (config.vapi.defaultAreaCode) req.numberDesiredAreaCode = config.vapi.defaultAreaCode;
    let p;
    try { p = await vapi.createPhoneNumber(req); }
    catch (e) { if (!req.numberDesiredAreaCode) throw e; delete req.numberDesiredAreaCode; p = await vapi.createPhoneNumber(req); }
    client = await db.updateClient(client.id, { vapiPhoneId: p.id, phoneNumber: p.number || null });
  }
  if (!client.phoneNumber && client.vapiPhoneId) {
    const p = await vapi.getPhoneNumber(client.vapiPhoneId);
    if (p?.number) client = await db.updateClient(client.id, { phoneNumber: p.number });
  }

  return {
    business: name,
    phoneNumber: client.phoneNumber,
    learned: site ? site.text.slice(0, 600) : '',
    websiteUrl: site?.url || '',
  };
}

export async function currentDemo({ db }) {
  const id = await db.getSetting('demo_client_id');
  const c = id ? await db.getClient(id) : null;
  return c ? { business: c.business, phoneNumber: c.phoneNumber, websiteUrl: c.details.websiteUrl || '' } : null;
}
