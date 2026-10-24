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
    },

    // Shared secret Vapi must present on webhook calls.
    webhookSecret: env.WEBHOOK_SECRET || '',
    // Token for the /api/admin endpoints.
    adminToken: env.ADMIN_TOKEN || '',

    // "auto": sign-ups go live with no human step. "approval" (default, safest for a fresh deploy):
    // they wait for /api/admin/clients/:id/approve. Switch to auto once you're ready.
    provisionMode: env.PROVISION_MODE === 'auto' ? 'auto' : 'approval',
    // Hard cap so a flood of fake sign-ups can't run up your Vapi bill.
    maxClients: int(env.MAX_CLIENTS, 10),
    signupsPerIpPerHour: int(env.SIGNUPS_PER_IP_PER_HOUR, 3),

    timezone: env.DEFAULT_TIMEZONE || 'America/New_York',

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
