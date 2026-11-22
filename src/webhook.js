// Handles what Vapi sends during and after calls: tool calls (booking) and end-of-call reports.
import { timingSafeEqual } from 'node:crypto';
import { openSlots } from './scheduling.js';
import { callSummaryEmail } from './emails.js';
import { callDuration, checkUsageAlerts, checkConcurrency } from './usage.js';
import { syncBooking } from './integrations/sync.js';
import { normalizePhone } from './phone.js';
import { countryOf } from './countries.js';
import { notify } from './notify.js';

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

async function runTool(call, client, deps) {
  const { db, now } = deps;
  const schedule = client.details.schedule;
  // Work that happens after answering, so the caller never waits on email, texts or another company's API.
  const later = deps.runInBackground || ((fn) => { fn().catch(() => {}); });

  if (call.name === 'check_availability') {
    const slots = openSlots(schedule, { now: now(), booked: await db.bookedSlotStarts(client.id) });
    if (!slots.length) return { slots: [], note: 'No open windows in the next week. Take a message so the team can call back.' };
    return { slots };
  }

  if (call.name === 'book_appointment') {
    const a = call.args;
    const valid = openSlots(schedule, { now: now(), booked: await db.bookedSlotStarts(client.id), limit: 200 });
    const slot = valid.find((s) => s.slot_start === clip(a.slot_start, 40));
    if (!slot) return { booked: false, reason: 'That window is not available. Call check_availability and offer new times.' };
    const saved = await db.addBooking({
      clientId: client.id, kind: 'booking', slotStart: slot.slot_start, slotLabel: slot.label,
      callerName: clip(a.name, 120), callerPhone: clip(a.phone, 40), address: clip(a.address), issue: clip(a.issue, 500),
      urgency: URGENCIES.includes(a.urgency) ? a.urgency : 'Routine', callId: call.callId, capacity: schedule.capacity,
    });
    if (!saved) return { booked: false, reason: 'Someone just took that window. Call check_availability and offer new times.' };
    later(() => syncBooking(deps, client, saved.id));
    later(() => notify(deps, client, 'booked', { booking: { ...saved, slot_label: slot.label, caller_name: saved.callerName, caller_phone: saved.callerPhone, issue: saved.issue, address: saved.address } }));
    return { booked: true, window: slot.label };
  }

  // ---- Changing an existing visit. The caller proves it's theirs with the phone number it was booked under.
  const samePhone = (a, b) => { const cc = countryOf(client).code; const x = normalizePhone(a, cc), y = normalizePhone(b, cc); return Boolean(x) && x === y; };
  const theirs = async (args) => {
    const b = await db.getBooking(client.id, clip(args.booking_id, 60));
    if (!b || b.kind !== 'booking' || b.canceled_at || Date.parse(b.slot_start) < now().getTime()) return null;
    return samePhone(b.caller_phone, args.phone) || samePhone(b.caller_phone, call.callerId) ? b : null;
  };

  if (call.name === 'find_booking') {
    const phones = [call.args.phone, call.callerId].filter(Boolean);
    const upcoming = (await db.listBookings(client.id))
      .filter((b) => b.kind === 'booking' && Date.parse(b.slot_start) >= now().getTime() && phones.some((p) => samePhone(b.caller_phone, p)))
      .sort((a, b) => a.slot_start.localeCompare(b.slot_start)).slice(0, 3);
    if (!upcoming.length) return { bookings: [], note: 'No upcoming visit under that number. Ask if it might be under another number, or take a message.' };
    return { bookings: upcoming.map((b) => ({ booking_id: b.id, window: b.slot_label, name: b.caller_name, address: b.address || undefined })) };
  }

  if (call.name === 'cancel_appointment') {
    const b = await theirs(call.args);
    if (!b) return { canceled: false, reason: 'No upcoming visit with that id under this caller\'s number. Call find_booking first, or take a message.' };
    await db.cancelBooking(client.id, b.id);
    later(() => notify(deps, client, 'canceled', { booking: b, reason: clip(call.args.reason, 200) }));
    return { canceled: true, window: b.slot_label };
  }

  if (call.name === 'reschedule_appointment') {
    const b = await theirs(call.args);
    if (!b) return { rescheduled: false, reason: 'No upcoming visit with that id under this caller\'s number. Call find_booking first.' };
    const booked = await db.bookedSlotStarts(client.id);
    booked.set(b.slot_start, Math.max(0, (booked.get(b.slot_start) || 1) - 1)); // their own seat doesn't count against them
    const slot = openSlots(schedule, { now: now(), booked, limit: 200 }).find((s) => s.slot_start === clip(call.args.slot_start, 40));
    if (!slot) return { rescheduled: false, reason: 'That window is not available. Call check_availability and offer new times.' };
    if (slot.slot_start === b.slot_start) return { rescheduled: true, window: slot.label, note: 'That is the time they already have.' };
    const saved = await db.addBooking({ clientId: client.id, kind: 'booking', slotStart: slot.slot_start, slotLabel: slot.label, callerName: b.caller_name, callerPhone: b.caller_phone,
      address: b.address, issue: b.issue, urgency: b.urgency, callId: call.callId, capacity: schedule.capacity });
    if (!saved) return { rescheduled: false, reason: 'Someone just took that window. Call check_availability and offer new times.' };
    await db.cancelBooking(client.id, b.id);
    later(() => syncBooking(deps, client, saved.id));
    later(() => notify(deps, client, 'rescheduled', { booking: b, newWindow: slot.label }));
    return { rescheduled: true, window: slot.label };
  }

  if (call.name === 'take_message') {
    const a = call.args;
    const m = await db.addBooking({
      clientId: client.id, kind: 'message', callerName: clip(a.name, 120), callerPhone: clip(a.phone, 40),
      issue: clip(a.issue, 500), urgency: URGENCIES.includes(a.urgency) ? a.urgency : 'Routine', callId: call.callId,
    });
    if (m) later(() => notify(deps, client, 'message', { item: { caller_name: m.callerName, caller_phone: m.callerPhone, issue: m.issue, urgency: m.urgency } }));
    return { saved: true };
  }

  return { error: `Unknown tool ${call.name}` };
}

export function createWebhookHandler(deps) {
  const { db, mailer, config, logger = console, now = () => new Date() } = deps;
  // Reads through to deps, so values set on it later (like a test's fake APIs) are still seen.
  const toolDeps = Object.assign(Object.create(deps), { now });
  return async function vapiWebhook(req, res) {
    if (!isAuthorized(req, config.webhookSecret)) return res.status(401).json({ error: 'unauthorized' });

    const message = req.body?.message || {};
    const client = await db.getClient(String(req.query.client || ''));
    const callId = message.call?.id || null;

    if (message.type === 'tool-calls') {
      const calls = extractToolCalls(message);
      const results = (await Promise.all(calls.map(async (c) => {
        if (!c.id) return null;
        if (!client) return { toolCallId: c.id, result: JSON.stringify({ error: 'This line is not set up. Take a message.' }) };
        try {
          return { toolCallId: c.id, result: JSON.stringify(await runTool({ ...c, callId, callerId: message.call?.customer?.number || '' }, client, toolDeps)) };
        } catch (e) {
          logger.error(`[webhook] tool ${c.name} failed: ${e.message}`);
          return { toolCallId: c.id, result: JSON.stringify({ error: 'Something went wrong. Take a message instead.' }) };
        }
      }))).filter(Boolean);
      // Vapi expects HTTP 200 even when a tool fails.
      return res.status(200).json({ results });
    }

    if (message.type === 'end-of-call-report' && client && callId) {
      const summary = clip(message.analysis?.summary ?? message.summary, 4000);
      const transcript = clip(message.artifact?.transcript ?? message.transcript, 50_000);
      const callerPhone = clip(message.call?.customer?.number ?? message.customer?.number, 40);
      // If the recovery job already handled this call (the report came very late), don't email twice.
      const seen = await db.getCall(callId);
      const cost = Number.isFinite(message.cost) ? message.cost : (Number.isFinite(message.call?.cost) ? message.call.cost : null);
      await db.saveCall({ id: callId, clientId: client.id, callerPhone, summary, transcript, endedReason: clip(message.endedReason, 80), durationS: callDuration(message), cost, source: 'webhook',
        startedAt: message.startedAt || message.call?.startedAt || (Number.isFinite(callDuration(message)) ? new Date(Date.now() - callDuration(message) * 1000).toISOString() : null) });

      if (!seen) {
        const items = (await db.listBookings(client.id)).filter((b) => b.call_id === callId);
        mailer.send(callSummaryEmail(config, client, { items, callerPhone, summary })
        ).catch((e) => logger.error(`[mail] call summary failed: ${e.message}`));
        // Hung up before anything was booked or taken down: a quick text so the lead isn't lost.
        const secs = callDuration(message);
        if (!items.length && callerPhone && Number.isFinite(secs) && secs < 20) notify(deps, client, 'hangup', { phone: callerPhone }).catch(() => {});
        checkUsageAlerts(client, deps).catch((e) => logger.error(`[usage] ${e.message}`));
        checkConcurrency(deps).catch((e) => logger.error(`[lines] ${e.message}`));
      }
    }

    return res.status(200).json({});
  };
}
