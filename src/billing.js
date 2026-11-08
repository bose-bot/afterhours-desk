// Subscriptions: Stripe for US shops, Razorpay for Indian shops (rupees, GST invoices).
// Each provider tells us about payments through a signed webhook; we keep the latest status on the shop.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { countryOf } from './countries.js';

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };

export function billingProvider(config, client) {
  const india = countryOf(client).code === 'IN';
  if (india) return config.razorpay.keyId && config.razorpay.keySecret && config.razorpay.planId ? 'razorpay' : null;
  return config.stripe.secretKey && config.stripe.priceId ? 'stripe' : null;
}

// ---- Stripe ----
export async function stripeCheckout(config, client, { successUrl, cancelUrl, fetchImpl }) {
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': config.stripe.priceId,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: client.id,
    customer_email: client.email,
    'subscription_data[metadata][client_id]': client.id,
    'metadata[client_id]': client.id,
  });
  if (config.stripe.trialDays > 0) form.set('subscription_data[trial_period_days]', String(config.stripe.trialDays));
  // Stripe Tax works out US sales tax by state; it needs the customer's address.
  if (config.stripe.automaticTax) { form.set('automatic_tax[enabled]', 'true'); form.set('billing_address_collection', 'required'); }
  const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) throw new Error(`Stripe: ${j.error?.message || `checkout failed (${res.status})`}`);
  return j.url;
}

// Stripe-Signature: "t=<unix>,v1=<hex hmac of `${t}.${raw}`>", within 5 minutes.
export function stripeSignatureValid(secret, header, raw, now = Date.now()) {
  if (!secret || !header) return false;
  let t = null; const sigs = [];
  for (const kv of String(header).split(',')) { const [k, v] = kv.split('='); if (k === 't') t = v; if (k === 'v1') sigs.push(v); }
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => safeEq(s, want));
}

// What a Stripe event means for one shop, or null if we don't care about it.
export function stripeEventUpdate(event) {
  const o = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed':
      return { clientId: o.client_reference_id || o.metadata?.client_id, status: 'active', subscriptionId: o.subscription, customerId: o.customer };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { clientId: o.metadata?.client_id, status: o.status, subscriptionId: o.id, customerId: o.customer };
    case 'customer.subscription.deleted':
      return { clientId: o.metadata?.client_id, status: 'canceled', subscriptionId: o.id, customerId: o.customer };
    case 'invoice.payment_failed':
      return { clientId: o.subscription_details?.metadata?.client_id || o.metadata?.client_id, status: 'past_due', subscriptionId: o.subscription, customerId: o.customer };
    default: return null;
  }
}

// ---- Razorpay ----
export async function razorpaySubscription(config, client, { fetchImpl }) {
  const res = await fetchImpl('https://api.razorpay.com/v1/subscriptions', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: config.razorpay.planId, total_count: 120, quantity: 1, customer_notify: 1, notes: { client_id: client.id, business: client.business.slice(0, 200) } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.short_url) throw new Error(`Razorpay: ${j.error?.description || `subscription failed (${res.status})`}`);
  return { url: j.short_url, subscriptionId: j.id };
}

// X-Razorpay-Signature: hex hmac of the raw body with the webhook secret.
export function razorpaySignatureValid(secret, header, raw) {
  if (!secret || !header) return false;
  return safeEq(header, createHmac('sha256', secret).update(raw).digest('hex'));
}

const RZP_STATUS = {
  'subscription.authenticated': 'pending', 'subscription.activated': 'active', 'subscription.charged': 'active',
  'subscription.resumed': 'active', 'subscription.pending': 'past_due', 'subscription.halted': 'past_due',
  'subscription.paused': 'paused', 'subscription.cancelled': 'canceled', 'subscription.completed': 'canceled',
};
export function razorpayEventUpdate(event) {
  const status = RZP_STATUS[event?.event];
  const sub = event?.payload?.subscription?.entity;
  if (!status || !sub) return null;
  return { clientId: sub.notes?.client_id, status, subscriptionId: sub.id, customerId: sub.customer_id };
}

// Saves a billing change on the shop, and tells the operator when a payment problem starts.
export async function applyBillingUpdate(provider, update, { db, mailer, config, logger = console }) {
  if (!update?.clientId) return false;
  const client = await db.getClient(update.clientId);
  if (!client) return false;
  const before = client.details.billing?.status;
  const billing = { ...(client.details.billing || {}), provider, status: update.status,
    ...(update.subscriptionId ? { subscriptionId: update.subscriptionId } : {}), ...(update.customerId ? { customerId: update.customerId } : {}),
    updatedAt: new Date().toISOString() };
  await db.updateClient(client.id, { details: { ...client.details, billing } });
  const trouble = ['past_due', 'unpaid', 'canceled', 'paused'];
  if (trouble.includes(update.status) && before !== update.status && config.mail.operatorEmail) {
    try {
      await mailer.send({ to: config.mail.operatorEmail, subject: `Billing: ${client.business} is ${update.status.replace('_', ' ')}`,
        text: `${client.business} (${client.email}) subscription is now "${update.status}" in ${provider === 'stripe' ? 'Stripe' : 'Razorpay'}.\n\nTheir receptionist keeps answering. Contact them, or pause the shop from the admin page if needed.` });
    } catch (e) { logger.error(`[billing] alert failed: ${e.message}`); }
  }
  return true;
}
