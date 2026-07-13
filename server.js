require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ── DB IN-MEMORY (fără uuid, fără dependențe externe) ──
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
  const s = { id: newId, plan: 'free', messages_used_today: 0, last_reset_date: new Date().toISOString().slice(0, 10) };
  memStore.set(newId, s);
  return s;
}
function increment(sessionId) {
  const s = memGet(sessionId);
  if (s) { s.messages_used_today++; return s.messages_used_today; }
  return 0;
}

// ── MIDDLEWARE ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 60*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// ── PLANS ──
const PLANS = { free: 5, pro: Infinity, premium: Infinity };
function remaining(session) {
  const limit = PLANS[session.plan] ?? 5;
  if (limit === Infinity) return 999;
  return Math.max(0, limit - (session.messages_used_today || 0));
}

// ── SYSTEM PROMPTS ──
const SYS = {
  ro: `Esti Noctis, un companion emotional AI empatic, disponibil 24/7. Esti cald, non-judecativ si empatic. Oferi sprijin emotional pentru: anxietate, bucuria casniciei, singuratate in doi, rani sufletesti, dependente, frica si fobii, LGBTQ+, armonie sexuala. NU esti terapeut uman. Vorbesti exclusiv romana. Raspunzi in 2-4 propozitii scurte, calde, empatice. CRIZA: La ganduri de autovatamare/suicid -> empatie maxima + indrumare la 0800 801 200.`,
  en: `You are Noctis, an empathetic AI emotional companion, available 24/7. Warm, non-judgmental. 2-4 short warm sentences. CRISIS: self-harm -> crisis services immediately.`,
  es: `Eres Noctis, companion emocional IA empatico 24/7. 2-4 oraciones cortas y calidas.`,
};

// ── ROUTES ──
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() });
});

app.get('/api/session', (req, res) => {
  try {
    const session = getOrCreate(req.query.sessionId || null);
    const limit = PLANS[session.plan] ?? 5;
    res.json({
      sessionId: session.id,
      plan: session.plan,
      remainingToday: remaining(session),
      dailyLimit: limit === Infinity ? null : limit
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

    if (remaining(session) <= 0)
      return res.status(429).json({ error: 'Ai atins limita zilnica.', code: 'DAILY_LIMIT_REACHED' });

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
    const usedNow = increment(session.id);
    const limit = PLANS[session.plan] ?? 5;
    const newRem = limit === Infinity ? 999 : Math.max(0, limit - usedNow);

    res.json({ reply, sessionId: session.id, remainingToday: newRem });

  } catch (err) {
    console.error('[Chat Error]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalid.' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🌙 Noctis v3.0 pornit pe portul ${PORT}`);
  console.log(`   Groq: ${process.env.GROQ_API_KEY ? 'configurat OK' : 'NECONFIGURAT'}`);
});

module.exports = app;
