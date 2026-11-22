// Tells the right people right away: texts to the owner for urgent calls (or every booking, if they
// want), a confirmation text to the caller, an email when a caller cancels or moves a visit, a text-back
// when a caller hangs up before saying anything, and a review request once a job is done.
// Texts go through Twilio and only when it is set up; email always works.
import { createTwilio } from './twilio.js';
import { ownerUrl } from './owner.js';
import { normalizePhone, prettyPhone } from './phone.js';
import { countryOf } from './countries.js';

export const smsReady = (config) => Boolean(config.twilio?.accountSid && config.twilio?.authToken && (config.sms?.from || config.sms?.messagingServiceSid));

/** The shop's text settings, with defaults: urgent alerts to the owner, confirmations to callers. */
export function textSettings(client) {
  const d = client.details || {};
  return {
    alerts: ['all', 'urgent', 'off'].includes(d.smsAlerts) ? d.smsAlerts : 'urgent',
    alertPhone: d.alertPhone || client.phone || '',
    confirmCallers: d.textCallers !== false,
    textBack: Boolean(d.textBack),
    reviewUrl: /^https:\/\//.test(d.reviewUrl || '') ? d.reviewUrl : '',
  };
}

async function sms(deps, to, body) {
  const { config, logger = console } = deps;
  if (!smsReady(config) || !to) return false;
  try {
    await createTwilio({ ...config.twilio, fetchImpl: deps.syncFetch || globalThis.fetch })
      .sendSms({ to, body, from: config.sms.from, messagingServiceSid: config.sms.messagingServiceSid });
    return true;
  } catch (e) { logger.error(`[sms] ${e.message}`); return false; }
}

const first = (name) => String(name || '').split(' ')[0] || 'there';

export async function notify(deps, client, kind, data = {}) {
  const { config, mailer, logger = console } = deps;
  const S = textSettings(client), brand = config.brandName, dash = ownerUrl(config, client);
  const caller = (p) => normalizePhone(p, countryOf(client).code);
  const b = data.booking || {}, m = data.item || {};

  if (kind === 'booked') {
    if (S.alerts === 'all') await sms(deps, S.alertPhone, `New booking: ${b.caller_name || 'Customer'}, ${b.slot_label}. ${b.issue || ''} ${prettyPhone(caller(b.caller_phone)) || ''}`.trim());
    if (S.confirmCallers) await sms(deps, caller(b.caller_phone), `${client.business}: you're booked for ${b.slot_label}. We'll call when we're on the way. To change it, call ${prettyPhone(client.phoneNumber) || 'us'}.`);
  }
  if (kind === 'message') {
    const urgent = m.urgency === 'Emergency' || m.urgency === 'Priority';
    if (S.alerts === 'all' || (S.alerts === 'urgent' && urgent)) {
      await sms(deps, S.alertPhone, `${m.urgency === 'Emergency' ? 'EMERGENCY' : m.urgency === 'Priority' ? 'URGENT' : 'Message'}: ${m.caller_name || 'Caller'} ${prettyPhone(caller(m.caller_phone)) || ''}: ${m.issue || ''}`.trim());
    }
  }
  if (kind === 'canceled' || kind === 'rescheduled') {
    const what = kind === 'canceled' ? `cancelled their visit on ${b.slot_label}` : `moved their visit from ${b.slot_label} to ${data.newWindow}`;
    const text = `${b.caller_name || 'A customer'} (${prettyPhone(caller(b.caller_phone)) || 'no number'}) ${what}.${data.reason ? `\nReason: ${data.reason}` : ''}${b.address ? `\nAddress: ${b.address}` : ''}${dash ? `\n\nDashboard: ${dash}` : ''}\n\n${brand}`;
    try { await mailer.send({ to: client.email, subject: `${kind === 'canceled' ? 'Cancelled' : 'Rescheduled'}: ${b.caller_name || 'customer'}, ${kind === 'canceled' ? b.slot_label : data.newWindow}`, text }); }
    catch (e) { logger.error(`[mail] ${kind}: ${e.message}`); }
    if (S.alerts !== 'off') await sms(deps, S.alertPhone, `${b.caller_name || 'A customer'} ${what}.`);
    if (kind === 'rescheduled' && S.confirmCallers) await sms(deps, caller(b.caller_phone), `${client.business}: your visit is now ${data.newWindow}.`);
  }
  if (kind === 'hangup' && S.textBack) {
    await sms(deps, caller(data.phone), `Sorry we missed you at ${client.business}. Call back any time on ${prettyPhone(client.phoneNumber) || 'this number'} and we'll book you in, day or night.`);
  }
  if (kind === 'review' && S.reviewUrl) {
    return sms(deps, caller(b.caller_phone), `Hi ${first(b.caller_name)}, thanks for choosing ${client.business}! If we did a good job, a quick review helps a lot: ${S.reviewUrl}`);
  }
  return true;
}
