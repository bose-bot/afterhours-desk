// Call minutes per shop per month, and an email to the operator when a shop nears its included minutes.

// "2026-11" for the month a moment falls in, in the given time zone.
export function monthKey(date, timezone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}

// Seconds a call lasted, from whichever fields Vapi sent.
export function callDuration(obj = {}) {
  if (Number.isFinite(obj.durationSeconds)) return obj.durationSeconds;
  if (Number.isFinite(obj.durationMs)) return obj.durationMs / 1000;
  const start = Date.parse(obj.startedAt || obj.call?.startedAt || ''), end = Date.parse(obj.endedAt || obj.call?.endedAt || '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
}

export async function usageThisMonth(db, client, { now = new Date(), timezone = 'America/New_York', includedMinutes = 0 } = {}) {
  const key = monthKey(now, timezone);
  // Look back far enough to cover the whole month, then keep only this month's calls.
  const since = new Date(now.getTime() - 32 * 86_400_000).toISOString();
  const rows = (await db.callsSince(client.id, since)).filter((r) => monthKey(new Date(r.created_at), timezone) === key);
  const seconds = rows.reduce((s, r) => s + (Number(r.duration_s) || 0), 0);
  const cost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  return { month: key, calls: rows.length, minutes: Math.ceil(seconds / 60), cost: Math.round(cost * 100) / 100, included: includedMinutes };
}

// Emails the operator once per shop per month at 80% and again at 100% of the included minutes.
// Calls keep being answered either way: this is a heads-up to talk to the shop, not a cutoff.
export async function checkUsageAlerts(client, { db, mailer, config, logger = console, now = () => new Date() }) {
  const included = config.includedMinutes;
  if (!included || client.status === 'demo') return null;
  const u = await usageThisMonth(db, client, { now: now(), timezone: config.timezone, includedMinutes: included });
  for (const level of [100, 80]) {
    if (u.minutes < included * level / 100) continue;
    const { created } = await db.getOrCreateSetting(`usage_alert:${client.id}:${u.month}:${level}`, () => new Date().toISOString());
    if (created && config.mail.operatorEmail) {
      try {
        await mailer.send({
          to: config.mail.operatorEmail,
          subject: `${client.business} has used ${level === 100 ? 'all' : '80%'} of its call minutes`,
          text: `${client.business} has used ${u.minutes} of ${included} included call minutes in ${u.month} (${u.calls} calls, about $${u.cost.toFixed(2)} in call costs).\n\nCalls are still being answered. Consider talking to the shop about a bigger plan.`,
        });
      } catch (e) { logger.error(`[usage] alert email failed: ${e.message}`); }
    }
    break; // only the highest level reached
  }
  return u;
}

// The most calls going on at the same moment since `sinceIso`, across every shop.
export function peakFrom(rows) {
  const ev = [];
  for (const r of rows) {
    const start = Date.parse(r.started_at), dur = Number(r.duration_s) || 0;
    if (!Number.isFinite(start)) continue;
    ev.push([start, 1], [start + dur * 1000, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end and a start at the same moment don't overlap
  let now = 0, peak = 0;
  for (const [, d] of ev) { now += d; peak = Math.max(peak, now); }
  return peak;
}

export async function busiestToday(db, now = new Date()) {
  return peakFrom(await db.callsStartedSince(new Date(now.getTime() - 24 * 3_600_000).toISOString()));
}

// Emails the operator once a day when calls at the same moment reach 80% of the account's lines,
// so more lines can be bought before callers get turned away.
export async function checkConcurrency({ db, mailer, config, logger = console, now = () => new Date() }) {
  const lines = config.vapi.concurrency;
  if (!lines) return null;
  const t = now(), peak = await busiestToday(db, t);
  if (peak < Math.ceil(lines * 0.8)) return peak;
  const { created } = await db.getOrCreateSetting(`concurrency_alert:${t.toISOString().slice(0, 10)}`, () => t.toISOString());
  if (created && config.mail.operatorEmail) {
    try {
      await mailer.send({ to: config.mail.operatorEmail, subject: `Phone lines: ${peak} of ${lines} in use at once`,
        text: `In the last 24 hours, ${peak} calls were going on at the same moment. Your Vapi account takes ${lines} at once and turns the next caller away.\n\nBuy more lines in the Vapi dashboard, then set VAPI_CONCURRENCY to the new number.` });
    } catch (e) { logger.error(`[lines] alert failed: ${e.message}`); }
  }
  return peak;
}
