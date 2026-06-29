-- NOCTIS — Schema PostgreSQL
-- Rulează o singură dată pe baza de date nouă
-- Compatibil cu Railway Postgres, Supabase, Neon.tech (toate gratuite la start)

-- ── SESIUNI ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,          -- UUID generat de server
  plan                TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | 'premium'
  messages_used_today INTEGER NOT NULL DEFAULT 0,
  last_reset_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  stripe_customer_id  TEXT,
  stripe_sub_id       TEXT,
  lang                TEXT DEFAULT 'ro',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pentru lookup rapid după Stripe customer
CREATE INDEX IF NOT EXISTS idx_sessions_stripe_customer ON sessions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_stripe_sub      ON sessions(stripe_sub_id);

-- ── MESAJE (opțional — pentru analytics) ─────────────────────────────────────
-- Dezactivat implicit — activează dacă vrei analytics
-- CREATE TABLE IF NOT EXISTS messages (
--   id          BIGSERIAL PRIMARY KEY,
--   session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
--   role        TEXT NOT NULL,  -- 'user' | 'assistant'
--   content     TEXT NOT NULL,
--   lang        TEXT DEFAULT 'ro',
--   tokens_in   INTEGER,
--   tokens_out  INTEGER,
--   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );

-- ── SUBSCRIBERS NEWSLETTER ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter (
  email       TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── FUNCȚIE: reset zilnic automat ─────────────────────────────────────────────
-- Alternativă la pg_cron: serverul face reset la fiecare GET /api/session
