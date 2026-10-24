// Storage. Uses Postgres when DATABASE_URL is set (for hosts without a persistent disk),
// otherwise a local SQLite file via Node's built-in driver. Every method is async.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Written so the same SQL runs on SQLite and Postgres.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,              -- pending_approval | provisioning | active | failed | paused
    business TEXT NOT NULL,
    contact TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    details TEXT NOT NULL,             -- JSON: area, hours, fees, numbers, services, notes, plan, areaCode, schedule
    vapi_assistant_id TEXT,
    vapi_phone_id TEXT,
    phone_number TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS clients_email ON clients(email)`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    kind TEXT NOT NULL,                -- booking | message
    slot_start TEXT,
    slot_label TEXT,
    caller_name TEXT,
    caller_phone TEXT,
    address TEXT,
    issue TEXT,
    urgency TEXT,
    call_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot ON bookings(client_id, slot_start) WHERE kind = 'booking'`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    client_id TEXT REFERENCES clients(id),
    caller_phone TEXT,
    summary TEXT,
    transcript TEXT,
    ended_reason TEXT,
    created_at TEXT NOT NULL
  )`,
];

// ---- Drivers: all(sql, params) -> rows, run(sql, params), close(). SQL uses ? placeholders. ----

async function sqliteDriver(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return {
    kind: 'sqlite',
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async run(sql, params = []) { db.prepare(sql).run(...params); },
    isUniqueViolation: (e) => String(e?.message).includes('UNIQUE'),
    async close() { db.close(); },
  };
}

async function postgresDriver(url) {
  const { default: pg } = await import('pg');
  // Managed databases usually want TLS; local and private-network ones often don't offer it.
  // Try TLS first (unless the URL or host says otherwise) and fall back if the server doesn't support it.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const wantsTls = !local && !/sslmode=disable/.test(url);
  const makePool = (ssl) => new pg.Pool({ connectionString: url, ssl, max: 5 });
  let pool = makePool(wantsTls ? { rejectUnauthorized: false } : false);
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    if (!wantsTls || !/does not support SSL/i.test(e.message)) { await pool.end(); throw e; }
    await pool.end();
    pool = makePool(false);
  }
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  return {
    kind: 'postgres',
    async all(sql, params = []) { return (await pool.query(toPg(sql), params)).rows; },
    async run(sql, params = []) { await pool.query(toPg(sql), params); },
    isUniqueViolation: (e) => e?.code === '23505',
    async close() { await pool.end(); },
  };
}

const now = () => new Date().toISOString();

const rowToClient = (r) => r && ({
  id: r.id, status: r.status, business: r.business, contact: r.contact, email: r.email, phone: r.phone,
  details: JSON.parse(r.details), vapiAssistantId: r.vapi_assistant_id ?? null, vapiPhoneId: r.vapi_phone_id ?? null,
  phoneNumber: r.phone_number ?? null, error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * openDb({ url }) for Postgres, openDb({ path }) for SQLite (":memory:" for tests).
 * A plain string is treated as a SQLite path.
 */
export async function openDb(target) {
  const opts = typeof target === 'string' ? { path: target } : target;
  const d = opts.url ? await postgresDriver(opts.url) : await sqliteDriver(opts.path);
  for (const stmt of SCHEMA) await d.run(stmt);
  const one = async (sql, params) => (await d.all(sql, params))[0];

  const api = {
    kind: d.kind,

    async createClient({ status, business, contact, email, phone, details }) {
      const id = randomUUID();
      const t = now();
      await d.run(`INSERT INTO clients (id, status, business, contact, email, phone, details, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, status, business, contact, email, phone, JSON.stringify(details), t, t]);
      return api.getClient(id);
    },

    async getClient(id) {
      return rowToClient(await one('SELECT * FROM clients WHERE id = ?', [id]));
    },

    async findClientByEmail(email) {
      return rowToClient(await one('SELECT * FROM clients WHERE email = ? ORDER BY created_at DESC LIMIT 1', [email]));
    },

    async listClients() {
      return (await d.all('SELECT * FROM clients ORDER BY created_at DESC')).map(rowToClient);
    },

    async countLiveClients() {
      const r = await one(`SELECT COUNT(*) AS n FROM clients WHERE status IN ('provisioning','active','pending_approval')`);
      return Number(r.n);
    },

    async updateClient(id, fields) {
      const map = { status: 'status', vapiAssistantId: 'vapi_assistant_id', vapiPhoneId: 'vapi_phone_id', phoneNumber: 'phone_number', error: 'error' };
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
      if (sets.length) {
        sets.push('updated_at = ?');
        vals.push(now(), id);
        await d.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
      return api.getClient(id);
    },

    // Returns null if the slot was already taken (the unique index enforces one booking per slot).
    async addBooking(b) {
      const id = randomUUID();
      try {
        await d.run(`INSERT INTO bookings (id, client_id, kind, slot_start, slot_label, caller_name, caller_phone, address, issue, urgency, call_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, b.clientId, b.kind, b.slotStart ?? null, b.slotLabel ?? null, b.callerName ?? null, b.callerPhone ?? null,
           b.address ?? null, b.issue ?? null, b.urgency ?? null, b.callId ?? null, now()]);
      } catch (e) {
        if (d.isUniqueViolation(e)) return null;
        throw e;
      }
      return { id, ...b };
    },

    async bookedSlotStarts(clientId) {
      const rows = await d.all(`SELECT slot_start FROM bookings WHERE client_id = ? AND kind = 'booking'`, [clientId]);
      return new Set(rows.map((r) => r.slot_start));
    },

    async listBookings(clientId) {
      return d.all('SELECT * FROM bookings WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
    },

    async saveCall({ id, clientId, callerPhone, summary, transcript, endedReason }) {
      await d.run(`INSERT INTO calls (id, client_id, caller_phone, summary, transcript, ended_reason, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (id) DO UPDATE SET client_id = excluded.client_id, caller_phone = excluded.caller_phone,
                     summary = excluded.summary, transcript = excluded.transcript, ended_reason = excluded.ended_reason`,
        [id, clientId ?? null, callerPhone ?? null, summary ?? null, transcript ?? null, endedReason ?? null, now()]);
    },

    async listCalls(clientId) {
      return d.all('SELECT * FROM calls WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
    },

    async getSetting(key) {
      return (await one('SELECT value FROM settings WHERE key = ?', [key]))?.value ?? null;
    },

    // Returns the stored value, creating it with make() the first time. Safe if two servers start at once.
    async getOrCreateSetting(key, make) {
      const existing = await api.getSetting(key);
      if (existing !== null) return { value: existing, created: false };
      const value = make();
      await d.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, value]);
      const stored = await api.getSetting(key);
      return { value: stored, created: stored === value };
    },

    close: () => d.close(),
  };
  return api;
}
