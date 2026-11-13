// Free first month: every shop's trial starts the moment its receptionist goes live. The owner is
// reminded 7 and 2 days before it ends, and on the day it ends. After a few days' grace without a
// subscription, the receptionist is paused: the shop's number stays theirs, and calls go straight to
// the shop's own on-call or office phone (Vapi's fallback). Paying resumes it straight away.
import { billingProvider } from './billing.js';
import { ownerUrl } from './owner.js';

const DAY = 86_400_000;
const PAID = ['active', 'trialing'];

export const isPaid = (client) => {
  const b = client?.details?.billing || {};
  return Boolean(b.manual) || PAID.includes(b.status);
};

/** The shop's details with a trial added, if trials are on and it doesn't have one yet. */
export function withTrial(details, config, now = new Date()) {
  if (!(config.trial?.days > 0) || details?.trial) return details;
  return { ...details, trial: { startedAt: now.toISOString(), endsAt: new Date(now.getTime() + config.trial.days * DAY).toISOString() } };
}

/** What the owner's dashboard and the admin page show. */
export function trialView(client, config, now = new Date()) {
  const t = client?.details?.trial;
  if (!t) return null;
  const msLeft = new Date(t.endsAt).getTime() - now.getTime();
  return {
    endsAt: t.endsAt,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY)),
    ended: msLeft <= 0,
    paid: isPaid(client),
    pausedForPayment: client.status === 'paused' && client.details?.pausedFor === 'trial',
    pausesAt: new Date(new Date(t.endsAt).getTime() + (config.trial?.graceDays || 0) * DAY).toISOString(),
  };
}

const fmtDate = (iso, client, config) => new Date(iso).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', timeZone: client.details?.schedule?.timezone || config.timezone || 'America/New_York',
});

function ownerMail(kind, client, config) {
  const url = ownerUrl(config, client);
  const brand = config.brandName;
  const pay = url ? `\n\nAdd payment from your dashboard: ${url}` : '\n\nReply to this email and we will send you an invoice.';
  const ends = fmtDate(client.details.trial.endsAt, client, config);
  const pausesOn = fmtDate(new Date(new Date(client.details.trial.endsAt).getTime() + (config.trial.graceDays || 0) * DAY).toISOString(), client, config);
  const M = {
    d7: [`7 days left in your free month`, `Your free month of ${brand} for ${client.business} ends on ${ends}.\n\nTo keep your receptionist answering without a break, add payment before then. You won't be charged until the free month is over.`],
    d2: [`Your free month ends in 2 days`, `Your free month for ${client.business} ends on ${ends}. Add payment now so callers keep reaching your receptionist. You won't be charged until ${ends}.`],
    end: [`Your free month has ended`, `Your free month for ${client.business} ended today. Your receptionist keeps answering until ${pausesOn}. Add payment before then to keep it on.`],
    paused: [`Your receptionist is paused`, `We paused the receptionist for ${client.business} because no payment was added after the free month. Your number is still yours: calls to it now go to your own phone.\n\nAdd payment and it starts answering again within a minute.`],
    resumed: [`Your receptionist is answering again`, `Thanks! Payment is set up and your receptionist for ${client.business} is answering calls again.`],
  }[kind];
  return { to: client.email, subject: M[0], text: `Hi ${client.contact},\n\n${M[1]}${kind === 'resumed' ? '' : pay}\n\n${brand}` };
}

async function sendOnce(kind, client, deps, msg) {
  const { db, mailer, logger = console } = deps;
  const { created } = await db.getOrCreateSetting(`trial_mail:${client.id}:${client.details.trial?.endsAt}:${kind}`, () => new Date().toISOString());
  if (!created) return false;
  try { await mailer.send(msg); } catch (e) { logger.error(`[trial] ${client.business}: ${e.message}`); }
  return true;
}

export async function pauseForPayment(client, deps) {
  const { db, vapi, config, logger = console } = deps;
  // No assistant on the number: Vapi sends the call to the number's fallback (the shop's own phone).
  if (client.vapiPhoneId) await vapi.updatePhoneNumber(client.vapiPhoneId, { assistantId: null });
  const c = await db.updateClient(client.id, { status: 'paused', details: { ...client.details, pausedFor: 'trial', pausedAt: new Date().toISOString() } });
  await sendOnce('paused', c, deps, ownerMail('paused', c, config));
  if (config.mail.operatorEmail) await sendOnce('paused-op', c, deps, { to: config.mail.operatorEmail, subject: `Paused for payment: ${c.business}`, text: `${c.business} (${c.email}) didn't add payment after the free month, so its receptionist is paused. Calls go to the shop's fallback number.\n\nTo give more time: Extend trial on the admin page.` });
  logger.log?.(`[trial] paused ${c.business}`);
  return c;
}

/** Turns the receptionist back on if it was paused only for payment. */
export async function resumeIfPaused(client, deps, { force = false } = {}) {
  const { db, vapi, config } = deps;
  if (client.status !== 'paused' || (client.details?.pausedFor !== 'trial' && !force)) return client;
  if (client.vapiPhoneId && client.vapiAssistantId) await vapi.updatePhoneNumber(client.vapiPhoneId, { assistantId: client.vapiAssistantId });
  const { pausedFor, pausedAt, ...details } = client.details;
  const c = await db.updateClient(client.id, { status: 'active', details });
  if (isPaid(c)) await deps.mailer.send(ownerMail('resumed', c, config)).catch(() => {});
  return c;
}

/** Runs every hour: starts trials for live shops without one, sends reminders, pauses and resumes. */
export async function runTrials(deps) {
  const { db, config, logger = console, now = () => new Date() } = deps;
  if (!(config.trial?.days > 0)) return { paused: 0, reminded: 0 };
  const t = now();
  let paused = 0, reminded = 0;
  for (let client of await db.listClients()) {
    try {
      if (client.status === 'paused' && client.details?.pausedFor === 'trial') {
        if (isPaid(client)) await resumeIfPaused(client, deps);
        continue;
      }
      if (client.status !== 'active' || isPaid(client) || client.details?.billing?.exempt) continue;
      if (!client.details?.trial) { // live before trials existed: their free month starts now
        client = await db.updateClient(client.id, { details: withTrial(client.details, config, t) });
        continue;
      }
      const v = trialView(client, config, t);
      const kind = v.ended ? 'end' : v.daysLeft <= 2 ? 'd2' : v.daysLeft <= 7 ? 'd7' : null;
      if (kind && await sendOnce(kind, client, deps, ownerMail(kind, client, config))) reminded++;
      if (t >= new Date(v.pausesAt)) {
        // Pause only when the owner can actually pay online; otherwise it's an invoice, so tell the operator.
        if (config.trial.endAction === 'pause' && billingProvider(config, client)) { await pauseForPayment(client, deps); paused++; }
        else if (config.mail.operatorEmail) await sendOnce('due-op', client, deps, { to: config.mail.operatorEmail, subject: `Free month over: ${client.business}`, text: `${client.business} (${client.email}) finished the free month without a subscription.${billingProvider(config, client) ? '' : ' Online payment isn\'t set up for this country, so send an invoice.'}\n\nThe receptionist is still answering. On the admin page: Mark paid, Extend trial, or Pause.` });
      }
    } catch (e) { logger.error(`[trial] ${client.business}: ${e.message}`); }
  }
  return { paused, reminded };
}
