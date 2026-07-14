# 🌙 Noctis — De la zero la live în 30 de minute

## Fișiere

```
noctis-backend/
├── server.js          ← serverul Express (API complet)
├── db.js              ← layer PostgreSQL cu fallback in-memory
├── schema.sql         ← structura bazei de date
├── stripe-setup.js    ← creează automat produsele în Stripe
├── index.html         ← frontend-ul (fără chei expuse)
├── .env.example       ← template variabile de mediu
├── railway.toml       ← config deploy Railway
└── package.json
```

---

## PASUL 1 — Setup local (5 min)

```bash
# Clonează/descarcă fișierele, apoi:
npm install
cp .env.example .env
```

Deschide `.env` și completează doar 2 câmpuri pentru start:
```
ANTHROPIC_API_KEY=sk-ant-...   ← de pe console.anthropic.com
STRIPE_SECRET_KEY=sk_test_...  ← de pe dashboard.stripe.com (TEST key!)
```

```bash
node server.js
# → 🌙 Noctis backend v2 pornit pe portul 3001
# → DB mode: in-memory (dev)
```

Deschide `index.html` în browser (sau `npx serve .`) — funcționează!

---

## PASUL 2 — Stripe (10 min)

### 2a. Creează produsele automat
```bash
node stripe-setup.js
# → Creează Pro + Premium cu toate prețurile (RO/EU/AU)
# → Actualizează automat .env cu price_xxx ID-urile
```

### 2b. Configurează webhook-ul local
```bash
# Instalează Stripe CLI: https://stripe.com/docs/stripe-cli
stripe login
stripe listen --forward-to localhost:3001/api/webhook
# → Te dă: whsec_xxx → pune în STRIPE_WEBHOOK_SECRET din .env
```

### 2c. Testează un upgrade
1. Deschide `index.html`, trimite 5 mesaje (limita free)
2. Click "Upgrade acum" → Stripe Checkout
3. Folosește cardul de test: `4242 4242 4242 4242` (orice dată/CVC)
4. → Reîntorci pe site cu plan Pro activ ✅

---

## PASUL 3 — Baza de date PostgreSQL (5 min)

Gratuit pe **Neon.tech** (recomandat) sau Railway Postgres:

### Neon.tech
1. Mergi pe [neon.tech](https://neon.tech) → New Project
2. Copiază `DATABASE_URL` (format: `postgresql://user:pass@host/dbname`)
3. Pune în `.env`: `DATABASE_URL=postgresql://...`
4. Rulează schema:
```bash
psql $DATABASE_URL < schema.sql
# sau din Neon Dashboard → SQL Editor → paste schema.sql
```

---

## PASUL 4 — Deploy pe Railway (10 min)

### 4a. Pregătire repository
```bash
git init
git add .
git commit -m "Noctis v2 — initial deploy"
# Push pe GitHub (repo privat!)
```

### 4b. Deploy
1. Mergi pe [railway.app](https://railway.app) → New Project
2. **Deploy from GitHub repo** → selectează repo-ul
3. **Add PostgreSQL** (din Railway Dashboard → New Service → Database → PostgreSQL)
4. Copiază `DATABASE_URL` din Railway Postgres → Variables în serviciul Node.js
5. Adaugă toate variabilele din `.env` în **Settings → Variables** Railway

Railway detectează automat Node.js și `railway.toml` → deploy automat.

**URL produs:** `https://noctis-backend-xxx.up.railway.app`

### 4c. Actualizează frontend
În `index.html`, linia:
```javascript
const BACKEND_URL = 'http://localhost:3001';
```
Schimb-o cu:
```javascript
const BACKEND_URL = 'https://noctis-backend-xxx.up.railway.app';
```

### 4d. Webhook producție
În Stripe Dashboard → Webhooks → Add endpoint:
- URL: `https://noctis-backend-xxx.up.railway.app/api/webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
- Copiază `whsec_` → Railway Variables → `STRIPE_WEBHOOK_SECRET`

---

## PASUL 5 — Deploy frontend (2 min)

**Netlify Drop** (cel mai simplu):
1. [app.netlify.com/drop](https://app.netlify.com/drop)
2. Trage `index.html` în pagină
3. URL instant — poți adăuga domeniu custom (noctis.ro)

---

## Checklist înainte de LIVE

- [ ] Stripe: chei TEST → **LIVE** (sk_live_...)
- [ ] `node stripe-setup.js` rulat cu cheia LIVE (creează produse noi)
- [ ] `BACKEND_URL` în `index.html` = URL Railway producție
- [ ] `CLIENT_URL` în Railway Variables = domeniu frontend
- [ ] Webhook URL actualizat în Stripe cu URL Railway producție
- [ ] Schema SQL rulată pe DB-ul de producție
- [ ] Test complet: mesaj → limită → checkout → upgrade → mesaje nelimitate

---

## Costuri & venituri estimate

| | La 50 abonați | La 200 abonați |
|---|---|---|
| Claude API | ~$10/lună | ~$40/lună |
| Railway | $0-5/lună | $5-10/lună |
| Stripe (1.4% + fee) | ~30 RON/lună | ~120 RON/lună |
| **Total costuri** | **~$15/lună** | **~$55/lună** |
| **Venituri Pro** | **2.450 RON/lună** | **9.800 RON/lună** |

---

## API Reference

| Endpoint | Descriere |
|---|---|
| `GET /api/status` | Health check + status DB |
| `GET /api/session?sessionId=xxx` | Creează/verifică sesiune |
| `POST /api/chat` | Trimite mesaj la Claude |
| `POST /api/checkout` | Inițiază Stripe Checkout |
| `POST /api/webhook` | Stripe webhook (intern) |
| `POST /api/newsletter` | Salvează email newsletter |

