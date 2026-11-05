// Recovers call reports that never reached this server: if it was asleep, restarting or down when a
// call ended, Vapi's end-of-call report is lost. Vapi still has the call, so we fetch recent calls
// for every live shop and handle any we haven't seen, exactly once.
import { callSummaryEmail } from './emails.js';
import { callDuration, checkUsageAlerts } from './usage.js';

const clip = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const SETTLE_MS = 3 * 60_000;     // give the normal webhook a few minutes to arrive first
const OVERLAP_MS = 2 * 3_600_000; // re-check the last two hours each run, in case a call was still going

export async function recoverCalls(deps) {
  const { db, vapi, mailer, config, logger = console, now = () => new Date() } = deps;
  const t = now();
  const last = Date.parse(await db.getSetting('calls_synced_at') || '') || (t.getTime() - 24 * 3_600_000);
  const since = new Date(Math.min(last, t.getTime()) - OVERLAP_MS).toISOString();
  const clients = (await db.listClients()).filter((c) => c.vapiAssistantId && ['active', 'demo'].includes(c.status));
  let recovered = 0;

  for (const client of clients) {
    let calls;
    try { calls = await vapi.listCalls({ assistantId: client.vapiAssistantId, createdAtGt: since, limit: 100 }); }
    catch (e) { logger.error(`[recover] ${client.business}: ${e.message}`); continue; }

    for (const c of Array.isArray(calls) ? calls : []) {
      const endedAt = Date.parse(c.endedAt || '');
      if (!c.id || c.status !== 'ended' || !Number.isFinite(endedAt) || t.getTime() - endedAt < SETTLE_MS) continue;
      if (await db.getCall(c.id)) continue;

      const callerPhone = clip(c.customer?.number, 40);
      const summary = clip(c.analysis?.summary ?? c.summary, 4000);
      await db.saveCall({
        id: c.id, clientId: client.id, callerPhone, summary,
        transcript: clip(c.artifact?.transcript ?? c.transcript, 50_000), endedReason: clip(c.endedReason, 80),
        durationS: callDuration(c), cost: Number.isFinite(c.cost) ? c.cost : null, source: 'recovered',
        createdAt: c.startedAt || c.createdAt || c.endedAt,
      });
      recovered++;
      // Bookings made during the call are already saved if the tool calls got through.
      const items = (await db.listBookings(client.id)).filter((b) => b.call_id === c.id);
      try { await mailer.send(callSummaryEmail(config, client, { items, callerPhone, summary, late: true })); }
      catch (e) { logger.error(`[recover] summary email failed: ${e.message}`); }
      await checkUsageAlerts(client, deps);
    }
  }
  await db.setSetting('calls_synced_at', t.toISOString());
  if (recovered) logger.log(`[recover] recovered ${recovered} call report(s)`);
  return { recovered, checkedShops: clients.length };
}
