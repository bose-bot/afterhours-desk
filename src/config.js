import { COUNTRY_CODES } from './countries.js';
// Reads settings from environment variables. See .env.example for every option.

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const config = {
    port: int(env.PORT, 3000),
    // Public https URL of this server. Vapi sends tool calls and call reports here.
    // Render sets RENDER_EXTERNAL_URL automatically, so one-click deploys need no manual URL.
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL
      || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),
    databasePath: env.DATABASE_PATH || './data/afterhours.db',
    // Postgres connection string. When set, it's used instead of the SQLite file (for hosts with no persistent disk).
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URI || '',

    vapi: {
      apiKey: env.VAPI_API_KEY || '',
      baseUrl: (env.VAPI_BASE_URL || 'https://api.vapi.ai').replace(/\/+$/, ''),
      modelProvider: env.VAPI_MODEL_PROVIDER || 'openai',
      model: env.VAPI_MODEL || 'gpt-4o',
      // Leave both empty to use Vapi's default voice.
      voiceProvider: env.VAPI_VOICE_PROVIDER || '',
      voiceId: env.VAPI_VOICE_ID || '',
      defaultAreaCode: env.DEFAULT_AREA_CODE || '',
      // Calls the account can take at the same moment (Vapi's default is 10). Used for the busy-line alert.
      concurrency: int(env.VAPI_CONCURRENCY, 10),
    },

    // Twilio, for US numbers once Vapi's 10 free numbers are used up. NUMBER_SOURCE=twilio uses it for every shop.
    twilio: { accountSid: env.TWILIO_ACCOUNT_SID || '', authToken: env.TWILIO_AUTH_TOKEN || '', always: env.NUMBER_SOURCE === 'twilio' },

    // Per-country settings, named with the two-letter code: VAPI_SIP_CREDENTIAL_AE (a licensed local
    // provider's SIP trunk in Vapi), TWILIO_BUNDLE_SID_GB / TWILIO_ADDRESS_SID_GB (Twilio's approved
    // regulatory bundle and address), STRIPE_PRICE_ID_CA (a price in that country's currency).
    countries: Object.fromEntries(COUNTRY_CODES.map((cc) => [cc, {
      sipCredentialId: env[`VAPI_SIP_CREDENTIAL_${cc}`] || (cc === 'IN' ? env.VAPI_IN_SIP_CREDENTIAL_ID || '' : ''),
      twilioBundleSid: env[`TWILIO_BUNDLE_SID_${cc}`] || '',
      twilioAddressSid: env[`TWILIO_ADDRESS_SID_${cc}`] || '',
      stripePriceId: env[`STRIPE_PRICE_ID_${cc}`] || '',
    }])),
    // A voice per caller language: VAPI_VOICE_AR_PROVIDER / VAPI_VOICE_AR_ID, VAPI_VOICE_EN_FR_…, VAPI_VOICE_HI_EN_…
    voiceFor: (lang) => {
      const k = String(lang || '').toUpperCase().replace(/-/g, '_');
      const provider = env[`VAPI_VOICE_${k}_PROVIDER`] || (k === 'HI_EN' ? env.VAPI_IN_VOICE_PROVIDER : '');
      const voiceId = env[`VAPI_VOICE_${k}_ID`] || (k === 'HI_EN' ? env.VAPI_IN_VOICE_ID : '');
      return provider && voiceId ? { provider, voiceId } : null;
    },

    // India: numbers come from an Indian licensed provider over SIP, set up once in Vapi as a credential.
    india: {
      sipCredentialId: env.VAPI_IN_SIP_CREDENTIAL_ID || '',
      voiceProvider: env.VAPI_IN_VOICE_PROVIDER || '',
      voiceId: env.VAPI_IN_VOICE_ID || '',
      // Hindi, English and a mix of both on one call.
      transcriber: { provider: env.VAPI_IN_TRANSCRIBER_PROVIDER || 'deepgram', model: env.VAPI_IN_TRANSCRIBER_MODEL || 'nova-3', language: env.VAPI_IN_TRANSCRIBER_LANGUAGE || 'multi' },
    },

    // Shared secret Vapi must present on webhook calls.
    webhookSecret: env.WEBHOOK_SECRET || '',
    // Token for the /api/admin endpoints.
    adminToken: env.ADMIN_TOKEN || '',
    // More people on the admin page: "Name:token,Name2:token2". Each token at least 24 characters.
    supportTokens: String(env.SUPPORT_TOKENS || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf(':');
      return { name: p.slice(0, i).trim(), token: p.slice(i + 1).trim() };
    }).filter((t) => t.name && t.token.length >= 24),

    // "auto": sign-ups go live with no human step. "approval" (default, safest for a fresh deploy):
    // they wait for /api/admin/clients/:id/approve. Switch to auto once you're ready.
    provisionMode: env.PROVISION_MODE === 'auto' ? 'auto' : 'approval',
    // Hard cap so a flood of fake sign-ups can't run up your Vapi bill.
    maxClients: int(env.MAX_CLIENTS, 10),
    signupsPerIpPerHour: int(env.SIGNUPS_PER_IP_PER_HOUR, 3),

    timezone: env.DEFAULT_TIMEZONE || 'America/New_York',

    // Call minutes included in a plan each month (the website says 300). You get an email at 80% and 100%.
    // Calls keep being answered past it. 0 turns the alerts off.
    includedMinutes: int(env.INCLUDED_MINUTES, 300),
    // How often to fetch call reports from Vapi that never reached this server. 0 turns it off.
    recoverEveryMinutes: int(env.RECOVER_EVERY_MINUTES, 10),
    // Free first month: starts when the receptionist goes live. TRIAL_DAYS=0 turns trials off.
    // After TRIAL_GRACE_DAYS without payment: 'pause' the receptionist (calls go to the shop's own phone), or just 'notify' you.
    trial: { days: int(env.TRIAL_DAYS, 30), graceDays: int(env.TRIAL_GRACE_DAYS, 3), endAction: env.TRIAL_END_ACTION === 'notify' ? 'notify' : 'pause' },
    // Billing. US shops pay through Stripe Checkout, Indian shops through a Razorpay subscription.
    stripe: { secretKey: env.STRIPE_SECRET_KEY || '', priceId: env.STRIPE_PRICE_ID || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      trialDays: int(env.STRIPE_TRIAL_DAYS, 14), automaticTax: bool(env.STRIPE_AUTOMATIC_TAX, false) },
    razorpay: { keyId: env.RAZORPAY_KEY_ID || '', keySecret: env.RAZORPAY_KEY_SECRET || '', planId: env.RAZORPAY_PLAN_ID || '', webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '' },
    // Jobber app credentials from developer.getjobber.com. Without them the "Connect Jobber" button is hidden.
    jobber: { clientId: env.JOBBER_CLIENT_ID || '', clientSecret: env.JOBBER_CLIENT_SECRET || '' },
    // Local hour (0-11) in each shop's time zone to email the overnight report. "off" turns it off.
    morningReportHour: /^off$/i.test(env.MORNING_REPORT_HOUR || '') ? null : Math.min(11, Math.max(0, int(env.MORNING_REPORT_HOUR, 7))),

    mail: {
      // Resend's HTTP API works on hosts that block SMTP ports. Takes priority over SMTP when set.
      resendApiKey: env.RESEND_API_KEY || '',
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
      // Where new-sign-up and failure alerts go (you, the operator).
      operatorEmail: env.OPERATOR_EMAIL || '',
    },

    brandName: env.BRAND_NAME || 'AfterHours Desk',
  };
  return config;
}

// Problems that stop the server from doing its job. Returned, not thrown, so tests can check them.
export function configProblems(config) {
  const problems = [];
  if (!config.vapi.apiKey) problems.push('VAPI_API_KEY is not set.');
  if (!/^https:\/\//.test(config.publicUrl)) problems.push('PUBLIC_URL must be the public https address of this server.');
  if (config.webhookSecret.length < 24) problems.push('WEBHOOK_SECRET must be at least 24 random characters.');
  if (config.adminToken.length < 24) problems.push('ADMIN_TOKEN must be at least 24 random characters.');
  return problems;
}
