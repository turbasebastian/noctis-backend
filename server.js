require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const Stripe     = require('stripe');
const db         = require('./db');

const app = express();

let _stripe = null;
function stripe() {
  if (!_stripe && process.env.STRIPE_SECRET_KEY)
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '16kb' }));

app.use(rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri. Incearca din nou in cateva minute.' },
}));

const PLANS = {
  free:    { dailyMessages: 5 },
  pro:     { dailyMessages: Infinity },
  premium: { dailyMessages: Infinity },
};

const SYSTEM_PROMPTS = {
  ro: `Esti Noctis, un companion emotional AI empatic, disponibil 24/7. Esti cald, non-judecativ si empatic. Oferi sprijin emotional pentru: anxietate, bucuria casniciei, singuratate in doi, rani sufletesti, dependente, frica si fobii, LGBTQ+, armonie sexuala. NU esti terapeut uman. Vorbesti exclusiv romana. Raspunzi in 2-4 propozitii scurte, calde, empatice. CRIZA: La ganduri de autovatamare/suicid -> empatie maxima + indrumare la 0800 801 200.`,
  en: `You are Noctis, an empathetic AI emotional companion, available 24/7. Warm, non-judgmental. Keep responses to 2-4 short warm sentences. CRISIS: self-harm -> refer to crisis services immediately.`,
  es: `Eres Noctis, companion emocional IA empatico 24/7. Responde en 2-4 oraciones cortas y calidas.`,
};

function remaining(session) {
  const limit = PLANS[session.plan]?.dailyMessages ?? 5;
  if (limit === Infinity) return 999;
  return Math.max(0, limit - (session.messages_used_today || 0));
}

app.get('/api/status', async (req, res) => {
  const dbStatus = await db.ping();
  res.json({ status: 'ok', version: '2.2.0-groq', timestamp: new Date().toISOString(), db: dbStatus });
});

app.get('/api/session', async (req, res) => {
  try {
    const session = await db.getOrCreateSession(req.query.sessionId || null);
    const limit = PLANS[session.plan]?.dailyMessages ?? 5;
    res.json({ sessionId: session.id, plan: session.plan, remainingToday: remaining(session), dailyLimit: limit === Infinity ? null : limit });
  } catch (err) {
    res.status(500).json({ error: 'Eroare server.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, messages, lang = 'ro' } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages[] obligatoriu.' });

  let session;
  try { session = await db.getOrCreateSession(sessionId || null); }
  catch (err) { return res.status(500).json({ error: 'Eroare server.' }); }

  if (remaining(session) <= 0)
    return res.status(429).json({ error: 'Ai atins limita zilnica.', code: 'DAILY_LIMIT_REACHED', plan: session.plan });

  const validMessages = messages
    .filter(m => m.role && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 2000) }));

  if (!validMessages.length) return res.status(400).json({ error: 'Mesaje invalide.' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 400, messages: [{ role: 'system', content: SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.ro }, ...validMessages] }),
    });
    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });
    const reply = data.choices?.[0]?.message?.content || 'A aparut o eroare. Te rog incearca din nou.';
    const usedNow = await db.incrementMessages(session.id);
    const limit = PLANS[session.plan]?.dailyMessages ?? 5;
    const newRem = limit === Infinity ? 999 : Math.max(0, limit - usedNow);
    res.json({ reply, sessionId: session.id, remainingToday: newRem });
  } catch (err) {
    res.status(502).json({ error: 'Serviciul AI este momentan indisponibil.' });
  }
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalid.' });
  await db.saveNewsletter(email);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🌙 Noctis backend v2.2 pornit pe portul ${PORT}`);
  console.log(`   Groq: ${process.env.GROQ_API_KEY ? 'configurat OK' : 'NECONFIGURAT'}`);
});

module.exports = app;
