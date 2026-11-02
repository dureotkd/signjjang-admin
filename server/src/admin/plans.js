const defaultPlans = [{
  billingPeriod: 'monthly', currency: 'KRW', features: ['계약서 작성 무제한', '계약서 관리', '일정 관리'],
  id: 'basic-monthly', name: 'BASIC', price: 99000, active: true,
}];

const parseFeatures = (value) => {
  if (Array.isArray(value)) return value;
  try { const result = JSON.parse(value); return Array.isArray(result) ? result : []; } catch { return []; }
};

async function listPlans(pool, { includeInactive = false } = {}) {
  try {
    const [rows] = await pool.execute(`SELECT id, name, price, currency, billing_period, features, active, updated_at
      FROM membership_plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY price, id`);
    return rows.map((row) => ({
      id: row.id, name: row.name, price: Number(row.price), currency: row.currency,
      billingPeriod: row.billing_period, features: parseFeatures(row.features), active: Boolean(row.active),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    }));
  } catch (error) {
    // Retain the existing mobile offering while a deployment is awaiting migration 006.
    if (error.code === 'ER_NO_SUCH_TABLE') return defaultPlans.map((plan) => ({ ...plan }));
    throw error;
  }
}

module.exports = { defaultPlans, listPlans };
