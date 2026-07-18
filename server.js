
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;
if (pool) pool.on('error', e => console.error('[DB]', e.message));

const memStore = new Map();
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function memGet(id) {
  const s = memStore.get(id);
  if (!s) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (s.last_reset_date !== today) { s.messages_used_today = 0; s.last_reset_date = today; }
  return s;
}

async function getOrCreate(id) {
  const today = new Date().toISOString().slice(0, 10);
  if (pool) {
    if (id) {
      const res = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
      if (res.rows.length > 0) {
        const s = res.rows[0];
        const sd = s.last_reset_date ? new Date(s.last_reset_date).toISOString().slice(0,10) : '';
        if (sd !== today) {
          await pool.query('UPDATE sessions SET messages_used_today=0, last_reset_date=$1, updated_at=NOW() WHERE id=$2', [today, id]);
          s.messages_used_today = 0;
        }
        return s;
      }
    }
    const newId = id || genId();
    const res = await pool.query(
      "INSERT INTO sessions (id,plan,messages_used_today,last_reset_date) VALUES ($1,'free',0,$2) ON CONFLICT(id) DO UPDATE SET updated_at=NOW() RETURNING *",
      [newId, today]
    );
    return res.rows[0];
  }
  if (id && memGet(id)) return memGet(id);
  const newId = id || genId();
  const s = { id: newId, plan: 'free', messages_used_today: 0, last_reset_date: today, country: null, currency: 'RON' };
  memStore.set(newId, s);
  return s;
}

async function increment(sessionId) {
  if (pool) {
    const res = await pool.query('UPDATE sessions SET messages_used_today=messages_used_today+1, updated_at=NOW() WHERE id=$1 RETURNING messages_used_today', [sessionId]);
    return res.rows[0]?.messages_used_today ?? 0;
  }
  const s = memGet(sessionId);
  if (s) { s.messages_used_today++; return s.messages_used_today; }
  return 0;
}

const CRISIS_KEYWORDS = ['suicid','ma omor','mă omor','nu mai vreau sa traiesc','vreau sa mor','vreau să mor','ma sinucid','end my life','kill myself','want to die'];
function isCrisis(text) { return CRISIS_KEYWORDS.some(kw => text.toLowerCase().includes(kw)); }

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 60*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));

const FREE_LIMIT = 8;
function remaining(session) {
  if (session.plan === 'standard') return 999;
  return Math.max(0, FREE_LIMIT - (session.messages_used_today || 0));
}

const PRICE_IDS = {
  RON: process.env.STRIPE_PRICE_RON,
  EUR: process.env.STRIPE_PRICE_EUR,
  GBP: process.env.STRIPE_PRICE_GBP,
  CAD: process.env.STRIPE_PRICE_CAD,
  AUD: process.env.STRIPE_PRICE_AUD,
  USD: process.env.STRIPE_PRICE_USD,
};

const SYS = {
  ro: `Esti Noctis. Esti un companion emotional AI empatic, disponibil 24/7. Esti cald, non-judecativ si empatic. Oferi sprijin emotional pentru: anxietate, bucuria casniciei, singuratate in doi, rani sufletesti, dependente, frica si fobii, LGBTQ+, armonie sexuala. NU esti terapeut uman. Vorbesti exclusiv romana. Raspunzi in 2-4 propozitii scurte, calde, empatice. CRIZA: La ganduri de autovatamare/suicid -> empatie maxima + indrumare imediata la 0800 801 200 (Antisuicid Romania, gratuit 24/7).`,
  en: `You are Noctis, an empathetic AI emotional companion, available 24/7. Warm, non-judgmental. 2-4 short warm sentences. CRISIS: self-harm -> refer immediately to crisis services.`,
  es: `Eres Noctis, companion emocional IA empatico 24/7. 2-4 oraciones cortas y calidas. CRISIS: autolesion -> recursos de crisis inmediatamente.`,
};

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '3.2.0', db: pool ? 'postgres' : 'memory', timestamp: new Date().toISOString() });
});

app.get('/api/session', async (req, res) => {
  try {
    const session = await getOrCreate(req.query.sessionId || null);
    if (!session.country) {
      try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`);
        const geo = await geoRes.json();
        if (geo.countryCode) {
          session.country = geo.countryCode;
          const currencyMap = { RO: 'RON', GB: 'GBP', CA: 'CAD', AU: 'AUD', US: 'USD' };
          session.currency = currencyMap[geo.countryCode] || 'EUR';
          if (pool) await pool.query('UPDATE sessions SET country=$1, currency=$2, updated_at=NOW() WHERE id=$3', [session.country, session.currency, session.id]);
        }
      } catch(e) {}
    }
    res.json({
      sessionId: session.id,
      plan: session.plan,
      remainingToday: remaining(session),
      dailyLimit: session.plan === 'standard' ? null : FREE_LIMIT,
      currency: session.currency || 'RON',
      country: session.country,
    });
  } catch (err) {
    console.error('[Session]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, messages, lang = 'ro' } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages[] obligatoriu.' });

    const session = await getOrCreate(sessionId || null);
    const lastMsg = messages[messages.length - 1]?.content || '';
    const crisis = isCrisis(lastMsg);

    if (!crisis && remaining(session) <= 0)
      return res.status(429).json({ error: 'Ai atins limita zilnica.', code: 'DAILY_LIMIT_REACHED', plan: session.plan, currency: session.currency || 'RON' });

    const validMessages = messages
      .filter(m => m.role && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 2000) }));

    if (!validMessages.length) return res.status(400).json({ error: 'Mesaje invalide.' });

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 400, messages: [{ role: 'system', content: SYS[lang] || SYS.ro }, ...validMessages] })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });

    const reply = data.choices?.[0]?.message?.content || 'A aparut o eroare.';
    if (!crisis && session.plan !== 'standard') await increment(session.id);

    res.json({ reply, sessionId: session.id, remainingToday: remaining(session), crisis });
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  const Stripe = require('stripe');
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) return res.status(503).json({ error: 'Platile nu sunt configurate.' });
  const { sessionId, currency = 'RON' } = req.body;
  const priceId = PRICE_IDS[currency] || PRICE_IDS.RON;
  if (!priceId) return res.status(400).json({ error: `Pret neconfigurat pentru ${currency}` });
  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL || 'https://turbasebastian.github.io/noctis-backend'}/?success=1&sid=${sessionId}`,
      cancel_url: `${process.env.CLIENT_URL || 'https://turbasebastian.github.io/noctis-backend'}/?canceled=1`,
      allow_promotion_codes: true,
      metadata: { noctisSessionId: sessionId || '', currency },
    });
    res.json({ url: checkout.url });
  } catch (err) {
    res.status(502).json({ error: 'Eroare la initierea platii.' });
  }
});

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.post('/api/webhook', async (req, res) => {
  const Stripe = require('stripe');
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === 'checkout.session.completed') {
    const cs = event.data.object;
    const noctisId = cs.metadata?.noctisSessionId;
    if (noctisId) {
      if (pool) await pool.query("UPDATE sessions SET plan='standard', messages_used_today=0, stripe_customer_id=$1, stripe_sub_id=$2, updated_at=NOW() WHERE id=$3", [cs.customer, cs.subscription, noctisId]);
      else { const s = memGet(noctisId); if (s) { s.plan = 'standard'; s.messages_used_today = 0; } }
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    if (pool) await pool.query("UPDATE sessions SET plan='free', updated_at=NOW() WHERE stripe_sub_id=$1", [event.data.object.id]);
  }
  res.json({ received: true });
});

app.post('/api/newsletter', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalid.' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🌙 Noctis v3.2 pornit pe portul ${PORT}`);
  console.log(`   DB:     ${pool ? 'PostgreSQL' : 'in-memory'}`);
  console.log(`   Groq:   ${process.env.GROQ_API_KEY ? 'OK' : 'NECONFIGURAT'}`);
});

module.exports = app;
