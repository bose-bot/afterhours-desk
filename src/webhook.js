// Handles what Vapi sends during and after calls: tool calls (booking) and end-of-call reports.
import { timingSafeEqual } from 'node:crypto';
import { openSlots } from './scheduling.js';

const URGENCIES = ['Emergency', 'Priority', 'Routine'];
const clip = (v, n = 300) => (v == null ? '' : String(v)).trim().slice(0, n);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// Accepts the secret as a URL token, a Bearer token, or the legacy x-vapi-secret header.
export function isAuthorized(req, secret) {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return safeEqual(req.query.token, secret) || safeEqual(bearer, secret) || safeEqual(req.get('x-vapi-secret'), secret);
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// Normalizes both payload shapes Vapi uses for tool calls.
export function extractToolCalls(message) {
  if (Array.isArray(message.toolCallList)) {
    return message.toolCallList.map((c) => ({ id: c.id, name: c.function?.name || c.name, args: parseArgs(c.function?.arguments ?? c.arguments) }));
  }
  if (Array.isArray(message.toolWithToolCallList)) {
    return message.toolWithToolCallList.map((t) => ({ id: t.toolCall?.id, name: t.toolCall?.function?.name || t.name, args: parseArgs(t.toolCall?.function?.arguments) }));
  }
  return [];
}

function runTool(call, client, { db, now }) {
  const schedule = client.details.schedule;

  if (call.name === 'check_availability') {
    const slots = openSlots(schedule, { now: now(), booked: db.bookedSlotStarts(client.id) });
    if (!slots.length) return { slots: [], note: 'No open windows in the next week. Take a message so the team can call back.' };
    return { slots };
  }

  if (call.name === 'book_appointment') {
    const a = call.args;
    const valid = openSlots(schedule, { now: now(), booked: db.bookedSlotStarts(client.id), limit: 200 });
    const slot = valid.find((s) => s.slot_start === clip(a.slot_start, 40));
    if (!slot) return { booked: false, reason: 'That window is not available. Call check_availability and offer new times.' };
    const saved = db.addBooking({
      clientId: client.id, kind: 'booking', slotStart: slot.slot_start, slotLabel: slot.label,
      callerName: clip(a.name, 120), callerPhone: clip(a.phone, 40), address: clip(a.address), issue: clip(a.issue, 500),
      urgency: URGENCIES.includes(a.urgency) ? a.urgency : 'Routine', callId: call.callId,
    });
    if (!saved) return { booked: false, reason: 'Someone just took that window. Call check_availability and offer new times.' };
    return { booked: true, window: slot.label };
  }

  if (call.name === 'take_message') {
    const a = call.args;
    db.addBooking({
      clientId: client.id, kind: 'message', callerName: clip(a.name, 120), callerPhone: clip(a.phone, 40),
      issue: clip(a.issue, 500), urgency: URGENCIES.includes(a.urgency) ? a.urgency : 'Routine', callId: call.callId,
    });
    return { saved: true };
  }

  return { error: `Unknown tool ${call.name}` };
}

export function createWebhookHandler({ db, mailer, config, logger = console, now = () => new Date() }) {
  return async function vapiWebhook(req, res) {
    if (!isAuthorized(req, config.webhookSecret)) return res.status(401).json({ error: 'unauthorized' });

    const message = req.body?.message || {};
    const client = db.getClient(String(req.query.client || ''));
    const callId = message.call?.id || null;

    if (message.type === 'tool-calls') {
      const calls = extractToolCalls(message);
      const results = calls.map((c) => {
        if (!c.id) return null;
        if (!client) return { toolCallId: c.id, result: JSON.stringify({ error: 'This line is not set up. Take a message.' }) };
        try {
          return { toolCallId: c.id, result: JSON.stringify(runTool({ ...c, callId }, client, { db, now })) };
        } catch (e) {
          logger.error(`[webhook] tool ${c.name} failed: ${e.message}`);
          return { toolCallId: c.id, result: JSON.stringify({ error: 'Something went wrong. Take a message instead.' }) };
        }
      }).filter(Boolean);
      // Vapi expects HTTP 200 even when a tool fails.
      return res.status(200).json({ results });
    }

    if (message.type === 'end-of-call-report' && client && callId) {
      const summary = clip(message.analysis?.summary ?? message.summary, 4000);
      const transcript = clip(message.artifact?.transcript ?? message.transcript, 50_000);
      const callerPhone = clip(message.call?.customer?.number ?? message.customer?.number, 40);
      db.saveCall({ id: callId, clientId: client.id, callerPhone, summary, transcript, endedReason: clip(message.endedReason, 80) });

      const items = db.listBookings(client.id).filter((b) => b.call_id === callId);
      const lines = items.map((b) => b.kind === 'booking'
        ? `BOOKED ${b.slot_label}: ${b.caller_name} ${b.caller_phone} | ${b.address} | ${b.issue} [${b.urgency}]`
        : `MESSAGE [${b.urgency}]: ${b.caller_name || 'Unknown'} ${b.caller_phone || callerPhone} | ${b.issue}`);
      const urgent = items.some((b) => b.urgency === 'Emergency');
      mailer.send({
        to: client.email,
        subject: `${urgent ? 'EMERGENCY · ' : ''}Call summary: ${items[0]?.caller_name || callerPhone || 'new caller'}`,
        text: `${lines.length ? lines.join('\n') + '\n\n' : ''}Caller: ${callerPhone || 'unknown'}\n\nSummary:\n${summary || '(no summary)'}\n`,
      }).catch((e) => logger.error(`[mail] call summary failed: ${e.message}`));
    }

    return res.status(200).json({});
  };
}
