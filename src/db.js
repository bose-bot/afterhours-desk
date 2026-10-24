// SQLite storage using Node's built-in driver (no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- pending_approval | provisioning | active | failed | paused
  business TEXT NOT NULL,
  contact TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  details TEXT NOT NULL,             -- JSON: area, hours, fees, numbers, services, notes, calendar, plan, areaCode
  vapi_assistant_id TEXT,
  vapi_phone_id TEXT,
  phone_number TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_email ON clients(email);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL,                -- booking | message
  slot_start TEXT,                   -- ISO time, bookings only
  slot_label TEXT,
  caller_name TEXT,
  caller_phone TEXT,
  address TEXT,
  issue TEXT,
  urgency TEXT,
  call_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot ON bookings(client_id, slot_start) WHERE kind = 'booking';

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,               -- Vapi call id
  client_id TEXT REFERENCES clients(id),
  caller_phone TEXT,
  summary TEXT,
  transcript TEXT,
  ended_reason TEXT,
  created_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const rowToClient = (r) => r && ({
    id: r.id, status: r.status, business: r.business, contact: r.contact, email: r.email, phone: r.phone,
    details: JSON.parse(r.details), vapiAssistantId: r.vapi_assistant_id, vapiPhoneId: r.vapi_phone_id,
    phoneNumber: r.phone_number, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  return {
    raw: db,

    createClient({ status, business, contact, email, phone, details }) {
      const id = randomUUID();
      const t = now();
      db.prepare(`INSERT INTO clients (id, status, business, contact, email, phone, details, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, status, business, contact, email, phone, JSON.stringify(details), t, t);
      return this.getClient(id);
    },

    getClient(id) {
      return rowToClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
    },

    findClientByEmail(email) {
      return rowToClient(db.prepare('SELECT * FROM clients WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email));
    },

    listClients() {
      return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all().map(rowToClient);
    },

    countLiveClients() {
      return db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE status IN ('provisioning','active','pending_approval')`).get().n;
    },

    updateClient(id, fields) {
      const map = { status: 'status', vapiAssistantId: 'vapi_assistant_id', vapiPhoneId: 'vapi_phone_id', phoneNumber: 'phone_number', error: 'error' };
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
      if (!sets.length) return this.getClient(id);
      sets.push('updated_at = ?'); vals.push(now(), id);
      db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return this.getClient(id);
    },

    // Returns null if the slot was already taken (the unique index enforces one booking per slot).
    addBooking(b) {
      const id = randomUUID();
      try {
        db.prepare(`INSERT INTO bookings (id, client_id, kind, slot_start, slot_label, caller_name, caller_phone, address, issue, urgency, call_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, b.clientId, b.kind, b.slotStart ?? null, b.slotLabel ?? null, b.callerName ?? null, b.callerPhone ?? null,
               b.address ?? null, b.issue ?? null, b.urgency ?? null, b.callId ?? null, now());
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return null;
        throw e;
      }
      return { id, ...b };
    },

    bookedSlotStarts(clientId) {
      return new Set(db.prepare(`SELECT slot_start FROM bookings WHERE client_id = ? AND kind = 'booking'`).all(clientId).map((r) => r.slot_start));
    },

    listBookings(clientId) {
      return db.prepare('SELECT * FROM bookings WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
    },

    saveCall({ id, clientId, callerPhone, summary, transcript, endedReason }) {
      db.prepare(`INSERT OR REPLACE INTO calls (id, client_id, caller_phone, summary, transcript, ended_reason, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, clientId ?? null, callerPhone ?? null, summary ?? null, transcript ?? null, endedReason ?? null, now());
    },

    listCalls(clientId) {
      return db.prepare('SELECT * FROM calls WHERE client_id = ? ORDER BY created_at DESC').all(clientId);
    },

    getSetting(key) {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },

    // Returns the stored value, creating it with make() the first time. created tells you which happened.
    getOrCreateSetting(key, make) {
      const existing = this.getSetting(key);
      if (existing !== null) return { value: existing, created: false };
      const value = make();
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      return { value, created: true };
    },

    close() { db.close(); },
  };
}
