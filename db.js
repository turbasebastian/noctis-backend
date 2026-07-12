const memStore = new Map();

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function memGet(id) {
  const s = memStore.get(id);
  if (!s) return null;
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

async function getOrCreateSession(id) {
  const today = new Date().toISOString().slice(0, 10);
  if (id && memGet(id)) return memGet(id);
  const newId = id || uuid();
  return memUpsert({
    id: newId,
    plan: 'free',
    messages_used_today: 0,
    last_reset_date: today,
    stripe_customer_id: null,
    stripe_sub_id: null
  });
}

async function incrementMessages(sessionId) {
  const s = memGet(sessionId);
  if (s) {
    s.messages_used_today++;
    memUpsert(s);
    return s.messages_used_today;
  }
  return 0;
}

async function upgradePlan(sessionId, plan, stripeCustomerId, stripeSubId) {
  const s = memGet(sessionId);
  if (s) {
    s.plan = plan;
    s.stripe_customer_id = stripeCustomerId;
    s.stripe_sub_id = stripeSubId;
    s.messages_used_today = 0;
    memUpsert(s);
  }
}

async function downgradeBySubId(stripeSubId) {
  for (const [, s] of memStore) {
    if (s.stripe_sub_id === stripeSubId) {
      s.plan = 'free';
      memUpsert(s);
    }
  }
}

async function findByStripeCustomer(stripeCustomerId) {
  for (const [, s] of memStore) {
    if (s.stripe_customer_id === stripeCustomerId) return s;
  }
  return null;
}

async function saveNewsletter(email) {
  return true;
}

async function ping() {
  return { ok: true, mode: 'memory' };
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
