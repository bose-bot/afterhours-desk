import { loadConfig, configProblems } from './config.js';
import { openDb } from './db.js';
import { createVapiClient } from './vapi.js';
import { createMailer } from './mailer.js';
import { createApp } from './server.js';
import { ensureSecrets } from './secrets.js';

const config = loadConfig();
const db = openDb(config.databasePath);
ensureSecrets(config, db);

const problems = configProblems(config);
if (problems.length) {
  console.error('Cannot start. Fix these settings (see .env.example):\n- ' + problems.join('\n- '));
  db.close();
  process.exit(1);
}

const vapi = createVapiClient({ apiKey: config.vapi.apiKey, baseUrl: config.vapi.baseUrl });
const mailer = createMailer(config.mail);
const app = createApp({ db, vapi, mailer, config });

const server = app.listen(config.port, () => {
  console.log(`${config.brandName} running at ${config.publicUrl} (${config.provisionMode} setup, max ${config.maxClients} clients, email: ${mailer.provider})`);
  if (!mailer.enabled) console.warn('Email is off: set RESEND_API_KEY and MAIL_FROM to send welcome emails and call summaries.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
