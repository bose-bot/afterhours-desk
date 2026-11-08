import { prettyPhone } from './phone.js';
import { createTwilio } from './twilio.js';
import { countryOf } from './countries.js';
// Turns a sign-up into a live receptionist: Vapi assistant -> phone number -> welcome email.
import { buildSystemPrompt, firstMessage, toolDefinitions, transferNumber } from './prompt.js';
import { welcomeEmail } from './emails.js';

export function webhookUrl(config, clientId) {
  const q = new URLSearchParams({ client: clientId, token: config.webhookSecret });
  return `${config.publicUrl}/api/vapi/webhook?${q}`;
}

export function assistantBody(config, client) {
  const url = webhookUrl(config, client.id);
  const body = {
    name: client.business.slice(0, 40),
    firstMessage: firstMessage(client),
    model: {
      provider: config.vapi.modelProvider,
      model: config.vapi.model,
      messages: [{ role: 'system', content: buildSystemPrompt(client) }],
      tools: toolDefinitions(url, { transferTo: transferNumber(client) }),
    },
    server: { url },
    serverMessages: ['end-of-call-report'],
    metadata: { clientId: client.id },
  };
  if (countryOf(client).code === 'IN') {
    // Hindi-English speech recognition, and an Indian voice when one is set.
    body.transcriber = { ...config.india.transcriber };
    if (config.india.voiceProvider && config.india.voiceId) body.voice = { provider: config.india.voiceProvider, voiceId: config.india.voiceId };
  } else if (config.vapi.voiceProvider && config.vapi.voiceId) {
    body.voice = { provider: config.vapi.voiceProvider, voiceId: config.vapi.voiceId };
  }
  return body;
}

// If Vapi can't start the assistant (deleted, misconfigured, an outage), the call rings a person
// instead of failing: the on-call number, then the office, then the owner's mobile.
export function fallbackDestination(client) {
  if (client.status === 'demo') return null;
  const d = client.details || {};
  const number = [d.oncall, d.office, client.phone].find((n) => /^\+\d{8,15}$/.test(n || ''));
  return number ? { type: 'number', number, message: 'Connecting you to the team now.' } : null;
}

const pretty = prettyPhone;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Vapi says e.g. "This area code is currently not available. Hint: Try one of 323, 213, 937."
const AREA_UNAVAILABLE = /area code.*not available/i;
export function suggestedAreaCodes(message) {
  const hint = /try one of ([\d,\s]+)/i.exec(message || '');
  return hint ? [...new Set(hint[1].match(/\b\d{3}\b/g) || [])] : [];
}

/**
 * Asks for a number in the shop's area code. If Vapi has none there, tries the area codes
 * Vapi suggests, then the operator's default, then any available number.
 */
async function createNumberWithFallback(vapi, client, config, logger, deps = {}) {
  const base = { provider: 'vapi', assistantId: client.vapiAssistantId, name: client.business.slice(0, 40) };
  const fallback = fallbackDestination(client);
  if (fallback) base.fallbackDestination = fallback;
  const twilioReady = Boolean(config.twilio?.accountSid && config.twilio?.authToken);
  if (twilioReady && config.twilio.always) return twilioNumber(vapi, client, config, base, deps);
  try {
    return await vapiFreeNumber(vapi, client, config, logger, base);
  } catch (e) {
    // Out of free numbers (Vapi allows 10), or none left near the shop: buy one on Twilio instead.
    if (!twilioReady) throw e;
    logger.warn(`[provision] Vapi number failed for ${client.business} (${e.message}); buying one on Twilio`);
    return twilioNumber(vapi, client, config, base, deps);
  }
}

async function twilioNumber(vapi, client, config, base, deps) {
  const tw = createTwilio({ ...config.twilio, fetchImpl: deps.syncFetch || globalThis.fetch });
  const bought = await tw.buyUsNumber({ areaCode: client.details.areaCode, friendlyName: client.business });
  try {
    const p = await vapi.createPhoneNumber({ ...base, provider: 'twilio', number: bought.number,
      twilioAccountSid: config.twilio.accountSid, twilioAuthToken: config.twilio.authToken });
    return { ...p, number: p.number || bought.number, twilioSid: bought.sid };
  } catch (e) {
    // Don't keep paying for a number Vapi couldn't take.
    await tw.release(bought.sid).catch(() => {});
    throw e;
  }
}

async function vapiFreeNumber(vapi, client, config, logger, base) {
  const tried = new Set();
  const queue = [client.details.areaCode, config.vapi.defaultAreaCode].filter(Boolean);
  let lastErr;

  while (queue.length) {
    const area = queue.shift();
    if (tried.has(area)) continue;
    tried.add(area);
    try {
      return await vapi.createPhoneNumber({ ...base, numberDesiredAreaCode: area });
    } catch (e) {
      if (!AREA_UNAVAILABLE.test(e.message)) throw e;
      lastErr = e;
      logger.warn(`[provision] no numbers in ${area} for ${client.business}; trying alternatives`);
      queue.push(...suggestedAreaCodes(e.message));
      if (tried.size >= 5) break;
    }
  }
  // Last resort: let Vapi pick any available number.
  try {
    return await vapi.createPhoneNumber(base);
  } catch (e) {
    throw lastErr && AREA_UNAVAILABLE.test(e.message) ? lastErr : e;
  }
}

/**
 * Runs (or re-runs) setup for one client. Safe to retry: steps that already finished are skipped.
 * deps: { db, vapi, mailer, config, logger, numberPollDelayMs }
 */
export async function provisionClient(clientId, deps) {
  const { db, vapi, mailer, config, logger = console, numberPollDelayMs = 3000 } = deps;
  let client = await db.getClient(clientId);
  if (!client) throw new Error(`No client ${clientId}`);
  client = await db.updateClient(clientId, { status: 'provisioning', error: null });

  let createdAssistantNow = false;
  try {
    if (!client.vapiAssistantId) {
      const a = await vapi.createAssistant(assistantBody(config, client));
      if (!a?.id) throw new Error('Vapi did not return an assistant id.');
      client = await db.updateClient(clientId, { vapiAssistantId: a.id });
      createdAssistantNow = true;
    }

    // India: numbers come from a licensed Indian provider, so the operator attaches one by hand.
    if (!client.vapiPhoneId && countryOf(client).code === 'IN') {
      client = await db.updateClient(clientId, { status: 'needs_number' });
      await safeSend(mailer, logger, {
        to: config.mail.operatorEmail,
        subject: `Attach an Indian number: ${client.business}`,
        text: `${client.business} (${client.email}) is set up and waiting for a +91 number.\n\nGet a number from your Indian provider, then on the admin page open the shop and use "Attach Indian number".`,
      });
      return client;
    }

    if (!client.vapiPhoneId) {
      const p = await createNumberWithFallback(vapi, client, config, logger, deps);
      if (!p?.id) throw new Error('Vapi did not return a phone number id.');
      client = await db.updateClient(clientId, { vapiPhoneId: p.id, phoneNumber: p.number || null,
        ...(p.twilioSid ? { details: { ...client.details, twilioNumberSid: p.twilioSid } } : {}) });
    }

    // New numbers can take a moment to be assigned.
    for (let i = 0; i < 3 && !client.phoneNumber; i++) {
      await sleep(numberPollDelayMs);
      const p = await vapi.getPhoneNumber(client.vapiPhoneId);
      if (p?.number) client = await db.updateClient(clientId, { phoneNumber: p.number });
    }

    client = await db.updateClient(clientId, { status: 'active' });
  } catch (err) {
    logger.error(`[provision] ${client.business} (${clientId}): ${err.message}`);
    // Don't leave an orphan assistant behind if the number step failed right after creating it.
    if (createdAssistantNow && !client.vapiPhoneId) {
      try { await vapi.deleteAssistant(client.vapiAssistantId); client = await db.updateClient(clientId, { vapiAssistantId: null }); }
      catch (e) { logger.error(`[provision] could not remove assistant ${client.vapiAssistantId}: ${e.message}`); }
    }
    client = await db.updateClient(clientId, { status: 'failed', error: err.message.slice(0, 500) });
    await safeSend(mailer, logger, {
      to: config.mail.operatorEmail,
      subject: `Setup failed: ${client.business}`,
      text: `Automatic setup failed for ${client.business} (${client.email}).\n\nError: ${err.message}\n\nFix the cause, then retry:\nPOST ${config.publicUrl}/api/admin/clients/${clientId}/retry`,
    });
    return client;
  }

  await safeSend(mailer, logger, welcomeEmail(config, client));
  await safeSend(mailer, logger, {
    to: config.mail.operatorEmail,
    subject: `New client live: ${client.business}`,
    text: `${client.business} is live.\nContact: ${client.contact}, ${client.email}, ${client.phone}\nNumber: ${client.phoneNumber || 'pending'}\nPlan: ${client.details.plan || 'not chosen'}`,
  });
  return client;
}

async function safeSend(mailer, logger, msg) {
  if (!msg.to) return;
  try { await mailer.send(msg); } catch (e) { logger.error(`[mail] "${msg.subject}" failed: ${e.message}`); }
}

// Fetches the number again for a client whose number wasn't assigned at setup time.
export async function refreshNumber(clientId, { db, vapi }) {
  const client = await db.getClient(clientId);
  if (!client?.vapiPhoneId) return client;
  const p = await vapi.getPhoneNumber(client.vapiPhoneId);
  return p?.number ? await db.updateClient(clientId, { phoneNumber: p.number }) : client;
}

// Pushes the current script (instructions, greeting, tools) to a live client's assistant,
// so wording changes reach shops that were set up earlier.
export async function updateScript(clientId, { db, vapi, config }) {
  const client = await db.getClient(clientId);
  if (!client?.vapiAssistantId) return { client, updated: false };
  const { name, firstMessage, model, server, serverMessages, voice, transcriber } = assistantBody(config, client);
  await vapi.updateAssistant(client.vapiAssistantId, { name, firstMessage, model, server, serverMessages, ...(voice ? { voice } : {}), ...(transcriber ? { transcriber } : {}) });
  // Shops set up before the fallback existed get it now.
  const fallback = fallbackDestination(client);
  if (client.vapiPhoneId && fallback) await vapi.updatePhoneNumber(client.vapiPhoneId, { fallbackDestination: fallback });
  return { client, updated: true };
}

/**
 * India: connects a +91 number from the shop's licensed provider (set up in Vapi as a SIP credential)
 * to the shop's assistant, then sends the welcome email.
 */
export async function attachIndianNumber(clientId, number, deps) {
  const { db, vapi, mailer, config, logger = console } = deps;
  let client = await db.getClient(clientId);
  if (!client) throw Object.assign(new Error('No client with that id.'), { status: 404 });
  if (countryOf(client).code !== 'IN') throw Object.assign(new Error('Only Indian shops get a number this way.'), { status: 409 });
  if (!config.india.sipCredentialId) throw Object.assign(new Error('Set VAPI_IN_SIP_CREDENTIAL_ID to your Indian provider\'s SIP credential in Vapi first.'), { status: 409 });
  if (!/^\+91\d{10}$/.test(number || '')) throw Object.assign(new Error('Enter the number as +91 and 10 digits.'), { status: 400 });
  if (!client.vapiAssistantId) throw Object.assign(new Error('Finish setup first: the shop has no assistant yet.'), { status: 409 });
  if (client.vapiPhoneId) throw Object.assign(new Error('This shop already has a number.'), { status: 409 });
  const body = { provider: 'byo-phone-number', number, credentialId: config.india.sipCredentialId, numberE164CheckEnabled: false,
    assistantId: client.vapiAssistantId, name: client.business.slice(0, 40) };
  const fallback = fallbackDestination(client);
  if (fallback) body.fallbackDestination = fallback;
  const p = await vapi.createPhoneNumber(body);
  if (!p?.id) throw new Error('Vapi did not return a phone number id.');
  client = await db.updateClient(clientId, { vapiPhoneId: p.id, phoneNumber: number, status: 'active', error: null });
  await safeSend(mailer, logger, welcomeEmail(config, client));
  return client;
}
