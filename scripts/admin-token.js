// Prints the admin token stored in the database. Run on the server: npm run admin-token
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const config = loadConfig();
if (config.adminToken) {
  console.log('ADMIN_TOKEN is set in the environment; that value is the admin token.');
} else {
  const db = openDb(config.databasePath);
  console.log(db.getSetting('admin_token') || 'No admin token yet. Start the server once to create it.');
  db.close();
}
