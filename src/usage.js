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
