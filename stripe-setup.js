/**
 * NOCTIS — Stripe Setup Script
 *
 * Creează automat toate produsele și prețurile în Stripe
 * și afișează ID-urile pentru .env
 *
 * Rulare: node stripe-setup.js
 * Asigură-te că STRIPE_SECRET_KEY este în .env (sau exportat ca env var)
 */

require('dotenv').config();
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('\n❌ STRIPE_SECRET_KEY lipsește din .env\n');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const isTest = process.env.STRIPE_SECRET_KEY.startsWith('sk_test_');

console.log(`\n🌙 Noctis — Stripe Setup`);
console.log(`   Mod: ${isTest ? '🧪 TEST' : '🚀 LIVE'}\n`);

async function setup() {
  const results = {};

  // ── PRODUSE ──────────────────────────────────────────────────────────────
  console.log('📦 Creare produse...\n');

  const proProduct = await stripe.products.create({
    name:        'Noctis Pro',
    description: 'Conversații nelimitate, jurnal de progres, exerciții terapeutice ghidate, suport 24/7',
    metadata:    { plan: 'pro', app: 'noctis' },
  });

  const premiumProduct = await stripe.products.create({
    name:        'Noctis Premium',
    description: 'Tot din Pro + rapoarte lunare, sesiuni de respirație & meditație, acces beta',
    metadata:    { plan: 'premium', app: 'noctis' },
  });

  console.log(`✅ Pro product:     ${proProduct.id}`);
  console.log(`✅ Premium product: ${premiumProduct.id}\n`);

  // ── PREȚURI ───────────────────────────────────────────────────────────────
  console.log('💰 Creare prețuri...\n');

  const prices = [
    // România (RON)
    { product: proProduct.id,     amount: 4900,  currency: 'ron', key: 'STRIPE_PRICE_PRO_RO',     label: 'Pro RO     (49 RON/lună)' },
    { product: premiumProduct.id, amount: 9900,  currency: 'ron', key: 'STRIPE_PRICE_PREMIUM_RO', label: 'Premium RO (99 RON/lună)' },
    // Europa (EUR)
    { product: proProduct.id,     amount: 900,   currency: 'eur', key: 'STRIPE_PRICE_PRO_EU',     label: 'Pro EU     (9 EUR/lună)'  },
    { product: premiumProduct.id, amount: 1900,  currency: 'eur', key: 'STRIPE_PRICE_PREMIUM_EU', label: 'Premium EU (19 EUR/lună)' },
    // Australia (AUD)
    { product: proProduct.id,     amount: 1500,  currency: 'aud', key: 'STRIPE_PRICE_PRO_AU',     label: 'Pro AU     (15 AUD/lună)' },
    { product: premiumProduct.id, amount: 2900,  currency: 'aud', key: 'STRIPE_PRICE_PREMIUM_AU', label: 'Premium AU (29 AUD/lună)' },
  ];

  for (const p of prices) {
    const price = await stripe.prices.create({
      product:    p.product,
      unit_amount:p.amount,
      currency:   p.currency,
      recurring:  { interval: 'month' },
    });
    results[p.key] = price.id;
    console.log(`✅ ${p.label}: ${price.id}`);
  }

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('📋 Adaugă aceste linii în .env:\n');
  for (const [key, id] of Object.entries(results)) {
    console.log(`${key}=${id}`);
  }
  console.log('\n' + '─'.repeat(60));

  // Scrie automat în .env dacă există
  const fs = require('fs');
  if (fs.existsSync('.env')) {
    let envContent = fs.readFileSync('.env', 'utf8');
    let updated = false;
    for (const [key, id] of Object.entries(results)) {
      if (envContent.includes(`${key}=`)) {
        envContent = envContent.replace(new RegExp(`${key}=.*`), `${key}=${id}`);
      } else {
        envContent += `\n${key}=${id}`;
      }
      updated = true;
    }
    if (updated) {
      fs.writeFileSync('.env', envContent);
      console.log('\n✅ .env actualizat automat cu ID-urile prețurilor!\n');
    }
  }

  console.log(`\n🎉 Setup complet! Acum rulează: node stripe-webhook-setup.js`);
  console.log(`   sau configurează webhook-ul manual în Dashboard:\n`);
  console.log(`   URL:    https://API_URL/api/webhook`);
  console.log(`   Events: checkout.session.completed`);
  console.log(`           customer.subscription.deleted`);
  console.log(`           invoice.payment_failed\n`);
}

setup().catch(err => {
  console.error('\n❌ Eroare:', err.message);
  if (err.message.includes('No such')) {
    console.error('   Verifică STRIPE_SECRET_KEY în .env');
  }
  process.exit(1);
});
