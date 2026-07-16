require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── DB IN-MEMORY ──
const memStore = new Map();
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function memGet(id) {
  const s = memStore.get(id);
  if (!s) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (s.last_reset_date !== today) { s.messages_used_today = 0; s.last_reset_date = today; }
  return s;
}
function getOrCreate(id) {
  if (id && memGet(id)) return memGet(id);
  const newId = id || genId();
  const s = { id: newId, plan: 'free', messages_used_today: 0, last_reset_date: new Date().toISOString().slice(0, 10), country: null, currency: 'RON' };
  memStore.set(newId, s);
  return s;
}
function increment(sessionId) {
  const s = memGet(sessionId);
  if (s) { s.messages_used_today++; return s.messages_used_today; }
  return 0;
}

// ── CRIZĂ KEYWORDS (bypass limită — mereu gratuit) ──
const CRISIS_KEYWORDS = ['suicid','ma omor','mă omor','nu mai vreau sa traiesc','nu mai vreau să trăiesc','vreau sa mor','vreau să mor','ma sinucid','mă sinucid','end my life','kill myself','want to die'];
function isCrisis(text) {
  return CRISIS_KEYWORDS.some(kw => text.toLowerCase().includes(kw));
}

// ── MIDDLEWARE ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 60*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// ── PLANS ──
const FREE_LIMIT = 8;
function remaining(session) {
  if (session.plan === 'standard') return 999;
  return Math.max(0, FREE_LIMIT - (session.messages_used_today || 0));
}

// ── PREȚURI STRIPE (multi-currency) ──
const PRICE_IDS = {
  RON: process.env.STRIPE_PRICE_RON,
  EUR: process.env.STRIPE_PRICE_EUR,
  GBP: process.env.STRIPE_PRICE_GBP,
  CAD: process.env.STRIPE_PRICE_CAD,
  AUD: process.env.STRIPE_PRICE_AUD,
  USD: process.env.STRIPE_PRICE_USD,
};

// ── SYSTEM PROMPTS ──
const SYS = {
  ro: `Esti Noctis. Astazi este ${new Date(Date.now()+3*3600000).toLocaleDateString("ro-RO",{weekday:"long",year:"numeric",month:"long",day:"numeric"})} ora ${new Date(Date.now()+3*3600000).toLocaleTimeString("ro-RO")}. Esti Noctis, un companion emotional AI empatic, disponibil 24/7. Esti cald, non-judecativ si empatic. Oferi sprijin emotional pentru: anxietate, bucuria casniciei, singuratate in doi, rani sufletesti, dependente, frica si fobii, LGBTQ+, armonie sexuala. NU esti terapeut uman. Vorbesti exclusiv romana. Raspunzi in 2-4 propozitii scurte, calde, empatice. CRIZA: La ganduri de autovatamare/suicid -> empatie maxima + indrumare imediata la 0800 801 200 (Antisuicid Romania, gratuit 24/7).`,
  en: `You are Noctis, an empathetic AI emotional companion, available 24/7. Warm, non-judgmental. 2-4 short warm sentences. CRISIS: self-harm or suicidal ideation -> maximum empathy + refer immediately to crisis services.`,
  es: `Eres Noctis, companion emocional IA empatico 24/7. 2-4 oraciones cortas y calidas. CRISIS: autolesion -> empatia maxima + recursos de crisis inmediatamente.`,
};

// ── ROUTES ──
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '3.1.0', timestamp: new Date().toISOString() });
});

app.get('/api/session', async (req, res) => {
  try {
    const session = getOrCreate(req.query.sessionId || null);

    // Detectare țară prin IP (pentru pricing regional)
    if (!session.country) {
      try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,currency`);
        const geo = await geoRes.json();
        if (geo.countryCode) {
          session.country = geo.countryCode;
          // Mapare țară -> currency
          const currencyMap = { RO: 'RON', GB: 'GBP', CA: 'CAD', AU: 'AUD', US: 'USD' };
          session.currency = currencyMap[geo.countryCode] || 'EUR';
        }
      } catch(e) { /* geo optional */ }
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

    const session = getOrCreate(sessionId || null);
    const lastMsg = messages[messages.length - 1]?.content || '';
    const crisis = isCrisis(lastMsg);

    // Verifică limita (bypass pentru criză)
    if (!crisis && remaining(session) <= 0)
      return res.status(429).json({
        error: 'Ai atins limita zilnica.',
        code: 'DAILY_LIMIT_REACHED',
        plan: session.plan,
        currency: session.currency || 'RON',
      });

    const validMessages = messages
      .filter(m => m.role && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 2000) }));

    if (!validMessages.length)
      return res.status(400).json({ error: 'Mesaje invalide.' });

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [{ role: 'system', content: SYS[lang] || SYS.ro }, ...validMessages]
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      console.error('[Groq]', groqRes.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });
    }

    const reply = data.choices?.[0]?.message?.content || 'A aparut o eroare. Te rog incearca din nou.';

    // Incrementează doar dacă nu e criză și e plan free
    if (!crisis && session.plan !== 'standard') {
      increment(session.id);
    }

    const newRem = remaining(session);

    res.json({ reply, sessionId: session.id, remainingToday: newRem, crisis });

  } catch (err) {
    console.error('[Chat Error]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkout — Stripe
app.post('/api/checkout', async (req, res) => {
  const Stripe = require('stripe');
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) return res.status(503).json({ error: 'Platile nu sunt configurate inca.' });

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
    console.error('[Stripe]', err.message);
    res.status(502).json({ error: 'Eroare la initierea platii.' });
  }
});

// POST /api/webhook — Stripe
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.post('/api/webhook', (req, res) => {
  const Stripe = require('stripe');
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) return res.status(503).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const cs = event.data.object;
    const noctisId = cs.metadata?.noctisSessionId;
    if (noctisId) {
      const s = memGet(noctisId);
      if (s) { s.plan = 'standard'; s.messages_used_today = 0; }
    }
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
  console.log(`\n🌙 Noctis v3.1 pornit pe portul ${PORT}`);
  console.log(`   Groq:   ${process.env.GROQ_API_KEY ? 'OK' : 'NECONFIGURAT'}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'neconfigurat'}`);
});

module.exports = app;
