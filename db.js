/**
 * NOCTIS — Database layer
 * PostgreSQL cu connection pool
 * Fallback la in-memory dacă DATABASE_URL nu e setat (dev fără DB)
 */

const { Pool } = require('pg');

// ── CONNECTION POOL ──────────────────────────────────────────────────────────
let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
  }
  return pool;
}

// ── IN-MEMORY FALLBACK ───────────────────────────────────────────────────────
// Folosit în development fără DATABASE_URL
const memStore = new Map();

function memGet(id) {
  const s = memStore.get(id);
  if (!s) return null;
  // reset zilnic
  const today = new Date().toISOString().slice(0, 10);
  if (s.last_reset_date !== today) {
    s.messages_used_today = 0;
    s.last_reset_date = today;
  }
  return s;
}

function memUpsert(session) {
  memStore.set(session.id, { ...session });
  return session;
}

// ── DB OPERATIONS ────────────────────────────────────────────────────────────

/**
 * Obține sau creează o sesiune
 * @param {string|null} id - sessionId din client (null = sesiune nouă)
 * @returns {Object} session
 */
async function getOrCreateSession(id) {
  const db = getPool();
  const today = new Date().toISOString().slice(0, 10);

  if (!db) {
    // fallback in-memory
    if (id && memGet(id)) return memGet(id);
  const uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
    const newId = id || uuid();
    return memUpsert({
      id: newId,
      plan: 'free',
      messages_used_today: 0,
      last_reset_date: today,
      stripe_customer_id: null,
      stripe_sub_id: null,
    });
  }

  // Încearcă să găsească sesiunea existentă
  if (id) {
    const res = await db.query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (res.rows.length > 0) {
      const s = res.rows[0];
      // Reset zilnic
      const sessionDate = s.last_reset_date
        ? new Date(s.last_reset_date).toISOString().slice(0, 10)
        : '';
      if (sessionDate !== today) {
        await db.query(
          'UPDATE sessions SET messages_used_today = 0, last_reset_date = $1, updated_at = NOW() WHERE id = $2',
          [today, id]
        );
        s.messages_used_today = 0;
        s.last_reset_date = today;
      }
      return s;
    }
  }

  // Creează sesiune nouă
 const uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const newId = id || uuid();
  const res = await db.query(
    `INSERT INTO sessions (id, plan, messages_used_today, last_reset_date)
     VALUES ($1, 'free', 0, $2)
     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [newId, today]
  );
  return res.rows[0];
}

/**
 * Incrementează contorul de mesaje
 */
async function incrementMessages(sessionId) {
  const db = getPool();
  if (!db) {
    const s = memGet(sessionId);
    if (s) { s.messages_used_today++; memUpsert(s); return s.messages_used_today; }
    return 0;
  }
  const res = await db.query(
    `UPDATE sessions
     SET messages_used_today = messages_used_today + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING messages_used_today`,
    [sessionId]
  );
  return res.rows[0]?.messages_used_today ?? 0;
}

/**
 * Upgradează planul după plată Stripe
 */
async function upgradePlan(sessionId, plan, stripeCustomerId, stripeSubId) {
  const db = getPool();
  if (!db) {
    const s = memGet(sessionId);
    if (s) {
      s.plan = plan;
      s.stripe_customer_id = stripeCustomerId;
      s.stripe_sub_id = stripeSubId;
      s.messages_used_today = 0;
      memUpsert(s);
    }
    return;
  }
  await db.query(
    `UPDATE sessions
     SET plan = $1, stripe_customer_id = $2, stripe_sub_id = $3,
         messages_used_today = 0, updated_at = NOW()
     WHERE id = $4`,
    [plan, stripeCustomerId, stripeSubId, sessionId]
  );
}

/**
 * Downgrade la free (abonament anulat)
 */
async function downgradeBySubId(stripeSubId) {
  const db = getPool();
  if (!db) {
    for (const [, s] of memStore) {
      if (s.stripe_sub_id === stripeSubId) {
        s.plan = 'free';
        memUpsert(s);
      }
    }
    return;
  }
  await db.query(
    `UPDATE sessions SET plan = 'free', updated_at = NOW() WHERE stripe_sub_id = $1`,
    [stripeSubId]
  );
}

/**
 * Găsește sessionId după stripeSubId (pentru webhook)
 */
async function findByStripeCustomer(stripeCustomerId) {
  const db = getPool();
  if (!db) {
    for (const [, s] of memStore) {
      if (s.stripe_customer_id === stripeCustomerId) return s;
    }
    return null;
  }
  const res = await db.query(
    'SELECT * FROM sessions WHERE stripe_customer_id = $1 LIMIT 1',
    [stripeCustomerId]
  );
  return res.rows[0] || null;
}

/**
 * Salvează email newsletter
 */
async function saveNewsletter(email) {
  const db = getPool();
  if (!db) return true;
  try {
    await db.query(
      'INSERT INTO newsletter (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [email.toLowerCase().trim()]
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Health check DB
 */
async function ping() {
  const db = getPool();
  if (!db) return { ok: true, mode: 'memory' };
  try {
    await db.query('SELECT 1');
    return { ok: true, mode: 'postgres' };
  } catch (e) {
    return { ok: false, mode: 'postgres', error: e.message };
  }
}

module.exports = {
  getOrCreateSession,
  incrementMessages,
  upgradePlan,
  downgradeBySubId,
  findByStripeCustomer,
  saveNewsletter,
  ping,
};
