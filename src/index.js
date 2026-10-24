import { loadConfig, configProblems } from './config.js';
import { openDb } from './db.js';
import { createVapiClient } from './vapi.js';
import { createMailer } from './mailer.js';
import { createApp } from './server.js';

const config = loadConfig();
const problems = configProblems(config);
if (problems.length) {
  console.error('Cannot start. Fix these settings (see .env.example):\n- ' + problems.join('\n- '));
  process.exit(1);
}

const db = openDb(config.databasePath);
const vapi = createVapiClient({ apiKey: config.vapi.apiKey, baseUrl: config.vapi.baseUrl });
const mailer = createMailer(config.mail);
const app = createApp({ db, vapi, mailer, config });

const server = app.listen(config.port, () => {
  console.log(`${config.brandName} running on port ${config.port} (${config.provisionMode} setup, max ${config.maxClients} clients)`);
  if (!mailer.enabled) console.warn('Email is off: set SMTP_HOST and MAIL_FROM to send welcome emails and call summaries.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
