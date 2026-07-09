/**
 * NOCTIS — Backend Server v2 (Groq edition — GRATUIT)
 * Express + Groq API + Stripe + PostgreSQL
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const Stripe     = require('stripe');
const db         = require('./db');

const app = express();

// ── STRIPE LAZY ──────────────────────────────────────────────────────────────
let _stripe = null;
function stripe() {
  if (!_stripe && process.env.STRIPE_SECRET_KEY)
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// ── SECURITY ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: false }));
  app.use(cors({ origin: '*', credentials: false }));
    app.use(cors({ origin: '*', credentials: false }));
    app.use(cors({ origin: '*', credentials: false }));
       app.use(cors({ origin: '*', credentials: false }));
  app.use(cors({ origin: '*', credentials: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '16kb' }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri. Încearcă din nou în câteva minute.' },
}));

// ── PLANS ─────────────────────────────────────────────────────────────────────
const PLANS = {
  free:    { dailyMessages: 5 },
  pro:     { dailyMessages: Infinity },
  premium: { dailyMessages: Infinity },
};

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────
const SYSTEM_PROMPTS = {
  ro: `Ești Noctis, un companion emoțional AI empatic, disponibil 24/7. Ești cald, non-judecativ și empatic. Oferi sprijin emoțional pentru: anxietate, bucuria căsniciei, singurătate în doi, răni sufletești, dependențe, frică și fobii, LGBTQ+, armonie sexuală.

NU ești terapeut uman — menționezi asta când e relevant. Dacă utilizatorul are nevoie de sprijin profesional, poți menționa cu blândețe că există psihologi disponibili (cabinet online dr. Sebastian Turba, la turba.ro).

Vorbești exclusiv română. Răspunzi în 2-4 propoziții scurte, calde, empatice. Nu dai sfaturi medicale concrete.

CRIZĂ: La gânduri de autoVătămare/suicid → empatie maximă + îndrumă imediat la 0800 801 200 (Antisuicid RO, gratuit 24/7).`,

  en: `You are Noctis, an empathetic AI emotional companion, available 24/7. Warm, non-judgmental, empathetic. You support users with: anxiety, relationship issues, loneliness, trauma, addictions, phobias, LGBTQ+, sexual harmony.

You are NOT a human therapist — mention this when relevant. Keep responses to 2-4 short, warm sentences. No concrete medical advice.

CRISIS: If you detect self-harm or suicidal ideation → maximum empathy + refer immediately to crisis services.`,

  es: `Eres Noctis, un compañero emocional IA empático, disponible 24/7. Cálido, sin juicios. Apoyas con: ansiedad, relaciones, soledad, trauma, adicciones, fobias, LGBTQ+, armonía sexual.

NO eres terapeuta humano — menciónalo cuando sea relevante. Responde en 2-4 oraciones cortas y cálidas. Sin consejos médicos concretos.`,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function remaining(session) {
  const limit = PLANS[session.plan]?.dailyMessages ?? 5;
  if (limit === Infinity) return 999;
  return Math.max(0, limit - (session.messages_used_today || 0));
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const dbStatus = await db.ping();
  res.json({
    status: 'ok',
    version: '2.1.0-groq',
    timestamp: new Date().toISOString(),
    db: dbStatus,
  });
});

app.get('/api/session', async (req, res) => {
  try {
    const session = await db.getOrCreateSession(req.query.sessionId || null);
    const limit   = PLANS[session.plan]?.dailyMessages ?? 5;
    res.json({
      sessionId:      session.id,
      plan:           session.plan,
      remainingToday: remaining(session),
      dailyLimit:     limit === Infinity ? null : limit,
    });
  } catch (err) {
    console.error('[Session]', err.message);
    res.status(500).json({ error: 'Eroare server.' });
  }
});

// POST /api/chat — folosește Groq (gratuit)
app.post('/api/chat', async (req, res) => {
  const { sessionId, messages, lang = 'ro' } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages[] obligatoriu.' });

  let session;
  try {
    session = await db.getOrCreateSession(sessionId || null);
  } catch (err) {
    return res.status(500).json({ error: 'Eroare server.' });
  }

  const rem = remaining(session);
  if (rem <= 0) {
    return res.status(429).json({
      error: 'Ai atins limita zilnică de mesaje gratuite.',
      code:  'DAILY_LIMIT_REACHED',
      plan:  session.plan,
    });
  }

  const validMessages = messages
    .filter(m => m.role && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, 2000),
    }));

  if (!validMessages.length)
    return res.status(400).json({ error: 'Mesaje invalide.' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.ro },
          ...validMessages,
        ],
      }),
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      console.error('[Groq]', groqRes.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });
    }

    const reply = data.choices?.[0]?.message?.content || 'A apărut o eroare. Te rog încearcă din nou.';

    const usedNow = await db.incrementMessages(session.id);
    const limit   = PLANS[session.plan]?.dailyMessages ?? 5;
    const newRem  = limit === Infinity ? 999 : Math.max(0, limit - usedNow);

    res.json({
      reply,
      sessionId:      session.id,
      remainingToday: newRem,
    });

  } catch (err) {
    console.error('[Groq Error]', err.message);
    res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Plățile nu sunt configurate încă.' });

  const { plan, region = 'ro', sessionId } = req.body;
  const PRICE_IDS = {
    pro_ro:     process.env.STRIPE_PRICE_PRO_RO,
    premium_ro: process.env.STRIPE_PRICE_PREMIUM_RO,
    pro_eu:     process.env.STRIPE_PRICE_PRO_EU,
    premium_eu: process.env.STRIPE_PRICE_PREMIUM_EU,
    pro_au:     process.env.STRIPE_PRICE_PRO_AU,
    premium_au: process.env.STRIPE_PRICE_PREMIUM_AU,
  };
  const priceId = PRICE_IDS[`${plan}_${region}`];
  if (!priceId) return res.status(400).json({ error: `Plan invalid: ${plan}_${region}` });

  try {
    const session = await s.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL}/?success=1&noctis_session=${sessionId}`,
      cancel_url:  `${process.env.CLIENT_URL}/?canceled=1`,
      allow_promotion_codes: true,
      metadata: { noctisSessionId: sessionId || '', plan, region },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe Checkout]', err.message);
    res.status(502).json({ error: 'Eroare la inițierea plății.' });
  }
});

app.post('/api/webhook', async (req, res) => {
  const s = stripe();
  if (!s) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object;
      const noctisId = cs.metadata?.noctisSessionId;
      const plan = cs.metadata?.plan;
      if (noctisId && plan) await db.upgradePlan(noctisId, plan, cs.customer, cs.subscription);
    }
    if (event.type === 'customer.subscription.deleted') {
      await db.downgradeBySubId(event.data.object.id);
    }
  } catch (err) {
    console.error('[Webhook]', err.message);
  }
  res.json({ received: true });
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalid.' });
  await db.saveNewsletter(email);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🌙 Noctis backend v2 (Groq) pornit pe portul ${PORT}`);
  console.log(`   DB mode: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory (dev)'}`);
  console.log(`   Groq:    ${process.env.GROQ_API_KEY ? 'configurat ✅' : 'NECONFIGURAT ❌'}`);
  console.log(`   Status:  http://localhost:${PORT}/api/status\n`);
});

module.exports = app;
