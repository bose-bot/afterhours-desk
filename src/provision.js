// Turns a sign-up into a live receptionist: Vapi assistant -> phone number -> welcome email.
import { buildSystemPrompt, firstMessage, toolDefinitions } from './prompt.js';

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
      tools: toolDefinitions(url),
    },
    server: { url },
    serverMessages: ['end-of-call-report'],
    metadata: { clientId: client.id },
  };
  if (config.vapi.voiceProvider && config.vapi.voiceId) {
    body.voice = { provider: config.vapi.voiceProvider, voiceId: config.vapi.voiceId };
  }
  return body;
}

function pretty(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function welcomeEmail(config, client) {
  const n = client.phoneNumber ? pretty(client.phoneNumber) : null;
  return {
    to: client.email,
    subject: `Your ${config.brandName} receptionist is live`,
    text: `Hi ${client.contact},

Your AI receptionist for ${client.business} is set up.

${n ? `Its phone number is ${n}.` : 'Its phone number is being activated and will be emailed to you shortly.'}

What to do next:
1. Call ${n || 'the number'} yourself and pretend to be a customer. Try booking a visit, and try "I smell gas" to hear the safety response.
2. Set your business line to forward calls to it when you're busy or closed. Most carriers call this "conditional call forwarding" (forward on busy / no answer). Your carrier's support page or app will show how.
3. Reply to this email with anything it should say differently.

New bookings and messages will be sent to this address.

${config.brandName}`,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs (or re-runs) setup for one client. Safe to retry: steps that already finished are skipped.
 * deps: { db, vapi, mailer, config, logger, numberPollDelayMs }
 */
export async function provisionClient(clientId, deps) {
  const { db, vapi, mailer, config, logger = console, numberPollDelayMs = 3000 } = deps;
  let client = db.getClient(clientId);
  if (!client) throw new Error(`No client ${clientId}`);
  client = db.updateClient(clientId, { status: 'provisioning', error: null });

  let createdAssistantNow = false;
  try {
    if (!client.vapiAssistantId) {
      const a = await vapi.createAssistant(assistantBody(config, client));
      if (!a?.id) throw new Error('Vapi did not return an assistant id.');
      client = db.updateClient(clientId, { vapiAssistantId: a.id });
      createdAssistantNow = true;
    }

    if (!client.vapiPhoneId) {
      const body = { provider: 'vapi', assistantId: client.vapiAssistantId, name: client.business.slice(0, 40) };
      const area = client.details.areaCode || config.vapi.defaultAreaCode;
      if (area) body.numberDesiredAreaCode = area;
      const p = await vapi.createPhoneNumber(body);
      if (!p?.id) throw new Error('Vapi did not return a phone number id.');
      client = db.updateClient(clientId, { vapiPhoneId: p.id, phoneNumber: p.number || null });
    }

    // New numbers can take a moment to be assigned.
    for (let i = 0; i < 3 && !client.phoneNumber; i++) {
      await sleep(numberPollDelayMs);
      const p = await vapi.getPhoneNumber(client.vapiPhoneId);
      if (p?.number) client = db.updateClient(clientId, { phoneNumber: p.number });
    }

    client = db.updateClient(clientId, { status: 'active' });
  } catch (err) {
    logger.error(`[provision] ${client.business} (${clientId}): ${err.message}`);
    // Don't leave an orphan assistant behind if the number step failed right after creating it.
    if (createdAssistantNow && !client.vapiPhoneId) {
      try { await vapi.deleteAssistant(client.vapiAssistantId); client = db.updateClient(clientId, { vapiAssistantId: null }); }
      catch (e) { logger.error(`[provision] could not remove assistant ${client.vapiAssistantId}: ${e.message}`); }
    }
    client = db.updateClient(clientId, { status: 'failed', error: err.message.slice(0, 500) });
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
  const client = db.getClient(clientId);
  if (!client?.vapiPhoneId) return client;
  const p = await vapi.getPhoneNumber(client.vapiPhoneId);
  return p?.number ? db.updateClient(clientId, { phoneNumber: p.number }) : client;
}
