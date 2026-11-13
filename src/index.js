import express from 'express';
import { loadConfig, configProblems } from './config.js';
import { openDb } from './db.js';
import { createVapiClient } from './vapi.js';
import { createMailer } from './mailer.js';
import { createApp } from './server.js';
import { ensureSecrets } from './secrets.js';
import { recoverCalls } from './recover.js';
import { runMorningReports } from './report.js';
import { runTrials } from './trial.js';

// Node's default listens on IPv6 and IPv4 where available (falls back to IPv4 only). Override with HOST.
const listen = (app, cb) => (process.env.HOST ? app.listen(config.port, process.env.HOST, cb) : app.listen(config.port, cb));

const config = loadConfig();
const db = await openDb(config.databaseUrl ? { url: config.databaseUrl } : { path: config.databasePath });
await ensureSecrets(config, db);
console.log(`Storage: ${db.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : `SQLite file at ${config.databasePath}`}`);

const problems = configProblems(config);
let server;

if (problems.length) {
  // Start anyway in "setup needed" mode, so the host's health check passes and the problem is visible
  // in the browser and the logs instead of a crash loop.
  console.error('SETUP NEEDED. Add these settings, then redeploy (see .env.example):\n- ' + problems.join('\n- '));
  const app = express();
  app.get('/healthz', (_req, res) => res.json({ ok: true, setupNeeded: problems }));
  app.use((_req, res) => res.status(503).type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup needed</title>
     <body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6">
     <h1>Almost there</h1><p>The server is running but needs these settings before it can take sign-ups:</p>
     <ul>${problems.map((p) => `<li>${p.replace(/</g, '&lt;')}</li>`).join('')}</ul>
     <p>Add them in your host's environment variables and redeploy.</p></body>`));
  server = listen(app, () => console.log(`Setup-needed page running on port ${config.port}`));
} else {
  const vapi = createVapiClient({ apiKey: config.vapi.apiKey, baseUrl: config.vapi.baseUrl });
  const mailer = createMailer(config.mail);
  const app = createApp({ db, vapi, mailer, config });
  // Pick up call reports that were lost while the server was asleep or restarting.
  if (config.recoverEveryMinutes > 0) {
    const recover = () => recoverCalls({ db, vapi, mailer, config }).catch((e) => console.error(`[recover] ${e.message}`));
    setTimeout(recover, 30_000).unref();
    setInterval(recover, config.recoverEveryMinutes * 60_000).unref();
  }
  // Morning reports: checked every 10 minutes; each shop gets at most one a day.
  if (config.morningReportHour != null) {
    const reports = () => runMorningReports({ db, mailer, config }).catch((e) => console.error(`[report] ${e.message}`));
    setTimeout(reports, 45_000).unref();
    setInterval(reports, 10 * 60_000).unref();
  }
  // Free month: reminders, pausing after the grace days, and starting trials for older live shops. Hourly.
  if (config.trial.days > 0) {
    const trials = () => runTrials({ db, vapi, mailer, config }).catch((e) => console.error(`[trial] ${e.message}`));
    setTimeout(trials, 60_000).unref();
    setInterval(trials, 60 * 60_000).unref();
  }
  server = listen(app, () => {
    console.log(`${config.brandName} running at ${config.publicUrl} on port ${config.port} (${config.provisionMode} setup, max ${config.maxClients} clients, email: ${mailer.provider})`);
    if (!mailer.enabled) console.warn('Email is off: set RESEND_API_KEY and MAIL_FROM to send welcome emails and call summaries.');
  });
}

server.on('error', (e) => { console.error(`Server failed to start: ${e.message}`); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(async () => { await db.close(); process.exit(0); }));
}
