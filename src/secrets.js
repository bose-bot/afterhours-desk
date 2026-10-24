// Fills in WEBHOOK_SECRET and ADMIN_TOKEN when they aren't set, so a fresh deploy needs no manual secrets.
// Generated values are stored in the database and stay the same across restarts.
import { randomBytes } from 'node:crypto';

const make = () => randomBytes(24).toString('hex');

export function ensureSecrets(config, db, logger = console) {
  if (!config.webhookSecret) {
    config.webhookSecret = db.getOrCreateSetting('webhook_secret', make).value;
  }
  if (!config.adminToken) {
    const { value, created } = db.getOrCreateSetting('admin_token', make);
    config.adminToken = value;
    if (created) {
      logger.log(`\n==== Your admin token (save it; shown once) ====\n${value}\nRetrieve it later with: npm run admin-token\n`);
    }
  }
  return config;
}
