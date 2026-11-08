// The morning report: one email per shop at 7 AM in the shop's time zone, covering everything since
// the last report. Nothing happened overnight means no email.
import { zonedParts } from './scheduling.js';
import { morningReportEmail } from './emails.js';

const RANK = { Emergency: 0, Priority: 1, Routine: 2 };

export function shopTimezone(client, config) {
  return client.details?.schedule?.timezone || config.timezone || 'America/New_York';
}

// What the report covers: calls and bookings/messages created since `since`.
export async function overnight(db, client, since) {
  const sinceMs = Date.parse(since);
  const after = (row) => Date.parse(row.created_at) >= sinceMs;
  const calls = (await db.listCalls(client.id)).filter(after);
  const items = (await db.listBookings(client.id)).filter(after);
  const callbacks = items.filter((b) => b.kind === 'message').sort((a, b) => (RANK[a.urgency] ?? 3) - (RANK[b.urgency] ?? 3));
  const booked = items.filter((b) => b.kind === 'booking').sort((a, b) => String(a.slot_start).localeCompare(String(b.slot_start)));
  return { calls, callbacks, booked };
}

export async function sendReport(client, deps, { since, force = false } = {}) {
  const { db, mailer, config } = deps;
  const data = await overnight(db, client, since);
  if (!force && !data.calls.length && !data.callbacks.length && !data.booked.length) return { sent: false, ...counts(data) };
  await mailer.send(morningReportEmail(config, client, data));
  return { sent: true, ...counts(data) };
}
const counts = (d) => ({ calls: d.calls.length, callbacks: d.callbacks.length, booked: d.booked.length });

export async function runMorningReports(deps) {
  const { db, config, logger = console, now = () => new Date() } = deps;
  const hour = config.morningReportHour;
  if (hour == null) return { sent: 0 };
  const t = now();
  let sent = 0;
  for (const client of await db.listClients()) {
    if (client.status !== 'active') continue;
    const local = zonedParts(t, shopTimezone(client, config));
    // Between the report hour and noon, so a server that was down at 7 still sends, but never in the afternoon.
    if (local.h < hour || local.h >= 12) continue;
    const day = `${local.y}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
    const { created } = await db.getOrCreateSetting(`morning_report:${client.id}:${day}`, () => t.toISOString());
    if (!created) continue;
    const sinceKey = `morning_report_since:${client.id}`;
    const since = (await db.getSetting(sinceKey)) || new Date(t.getTime() - 24 * 3_600_000).toISOString();
    try {
      const r = await sendReport(client, deps, { since });
      if (r.sent) sent++;
      await db.setSetting(sinceKey, t.toISOString());
    } catch (e) { logger.error(`[report] ${client.business}: ${e.message}`); }
  }
  return { sent };
}
