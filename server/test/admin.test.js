const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createAdminRouter } = require('../src/admin/routes');
const { AdminRepository } = require('../src/admin/repository');
const { AppError } = require('../src/errors');

const secret = 'admin-test-secret-that-is-at-least-thirty-two-characters';
const config = { jwt: { secret }, admin: { username: 'operator', passwordHash: bcrypt.hashSync('test-password', 4), name: '운영자' } };

async function fixture(context, { repository = {}, settings = config } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ config: settings, repository }));
  app.use((error, _request, response, _next) => response.status(error.status || 500).json({ success: false, error: { code: error.code, message: error.message } }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const request = (path, { token, method = 'GET', body } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const login = await request('/auth/login', { method: 'POST', body: { password: 'test-password' } });
  const result = await login.json();
  return { request, token: result.data?.accessToken };
}

test('admin login issues a bounded dedicated token and validates credentials', async (context) => {
  const { request, token } = await fixture(context);
  const decoded = jwt.verify(token, secret, { audience: 'signjang-admin', issuer: 'signjang-api' });
  assert.equal(decoded.type, 'admin');
  assert.equal(decoded.sub, 'operator');
  assert.equal(decoded.exp - decoded.iat, 8 * 60 * 60);
  const session = await request('/auth/session', { token });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await session.json()).data.admin, { username: 'operator', name: '운영자' });
  const invalid = await request('/auth/login', { method: 'POST', body: { username: 'operator', password: 'wrong' } });
  assert.equal(invalid.status, 401);
  const legacy = await request('/auth/login', { method: 'POST', body: { username: 'operator', password: 'test-password' } });
  assert.equal(legacy.status, 200);
  const wrongUsername = await request('/auth/login', { method: 'POST', body: { username: 'different', password: 'test-password' } });
  assert.equal(wrongUsername.status, 401);
});

test('admin API rejects ordinary, expired, audience-less and absent access tokens', async (context) => {
  let calls = 0;
  const { request } = await fixture(context, { repository: { async list() { calls += 1; return {}; } } });
  const tokens = [undefined,
    jwt.sign({ type: 'access' }, secret, { subject: '7', expiresIn: '1h' }),
    jwt.sign({ type: 'admin' }, secret, { subject: 'operator', expiresIn: '1h' }),
    jwt.sign({ type: 'admin' }, secret, { subject: 'operator', audience: 'signjang-admin', issuer: 'signjang-api', expiresIn: -1 }),
  ];
  for (const token of tokens) assert.equal((await request('/users', { token })).status, 401);
  assert.equal(calls, 0);
});

test('an invalid configured admin hash does not expose resources or permit credentials', async (context) => {
  const { request } = await fixture(context, { settings: { jwt: { secret }, admin: { username: '', passwordHash: 'invalid-hash' } } });
  assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } })).status, 503);
  assert.equal((await request('/users')).status, 503);
});

test('password-only login uses the internal admin identity and accepts short configured passwords', async (context) => {
  const { request } = await fixture(context, { settings: { jwt: { secret }, admin: { passwordHash: bcrypt.hashSync('x', 4) } } });
  const response = await request('/auth/login', { method: 'POST', body: { password: 'x' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.admin.username, process.env.ADMIN_USERNAME || 'admin');
  for (const password of ['', 'a'.repeat(73), '가'.repeat(25)]) {
    assert.equal((await request('/auth/login', { method: 'POST', body: { password } })).status, 400);
  }
});

test('bounded list validation rejects SQL injection, unknown fields and unsupported statuses', async (context) => {
  const calls = [];
  const { request, token } = await fixture(context, { repository: { async list(resource, query) { calls.push({ resource, query }); return { items: [], total: 0, ...query }; } } });
  for (const query of ['limit=101', 'page=0', 'limit=1%20UNION%20SELECT', 'sort=password_hash', 'status=admin', 'from=2026-02-30', 'from=2026-11-01&to=2026-01-01']) {
    assert.equal((await request(`/users?${query}`, { token })).status, 400, query);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request('/users?page=2&limit=10&q=kim&status=inactive', { token })).status, 200);
  assert.deepEqual(calls[0], { resource: 'users', query: { page: 2, limit: 10, q: 'kim', status: 'inactive' } });
  assert.equal((await request('/users?progress=scheduled', { token })).status, 400);
  assert.equal((await request('/contracts?status=scheduled', { token })).status, 400);
  assert.equal((await request('/contracts?progress=scheduled', { token })).status, 200);
  assert.deepEqual(calls[1], { resource: 'contracts', query: { page: 1, limit: 20, progress: 'scheduled' } });
});

test('admin mutation permits whitelisted fields only and validates stable slug keys', async (context) => {
  const calls = [];
  const { request, token } = await fixture(context, { repository: { async patch(...arguments_) { calls.push(arguments_); return { id: arguments_[1] }; } } });
  for (const body of [{ role: 'admin' }, { passwordHash: 'injected' }, { status: 'withdrawn' }, {}]) {
    assert.equal((await request('/users/7', { method: 'PATCH', token, body })).status, 400);
  }
  assert.equal((await request('/deliveries/7', { method: 'PATCH', token, body: { status: 'sent' } })).status, 405);
  assert.equal((await request('/users/7', { method: 'PATCH', token, body: { status: 'inactive' } })).status, 200);
  assert.equal((await request('/terms/privacy', { method: 'PATCH', token, body: { body: '새 약관' } })).status, 200);
  assert.equal((await request('/plans/basic-monthly', { method: 'PATCH', token, body: { price: 99000, features: ['기능'] } })).status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[1][1], 'privacy');
});

test('admin dashboard caps date span and rejects invalid dates before database access', async (context) => {
  let calls = 0;
  const { request, token } = await fixture(context, { repository: { async dashboard(period) { calls += 1; return period; } } });
  assert.equal((await request('/dashboard?from=2020-01-01&to=2026-01-01', { token })).status, 400);
  assert.equal((await request('/dashboard?from=2026-02-30', { token })).status, 400);
  const valid = await request('/dashboard?from=2026-10-01&to=2026-10-31', { token });
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).data, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(calls, 1);
});

test('repository whitelists resource identifiers and parameterizes literal search values', async () => {
  const calls = [];
  const repository = new AdminRepository({ async execute(sql, parameters) { calls.push({ sql, parameters }); return [sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ id: 7, full_name: '홍길동' }]]; } });
  const q = "%' OR 1=1 --_";
  const result = await repository.list('users', { page: 1, limit: 20, q });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].fullName, '홍길동');
  assert.equal(result.items[0].id, '7');
  for (const { sql, parameters } of calls) {
    assert.ok(!sql.includes(q));
    assert.equal(parameters[0], "%!%' OR 1=1 --!_%");
  }
  await assert.rejects(repository.list('users; DROP TABLE users', { page: 1, limit: 20 }), (error) => error instanceof AppError && error.status === 404);
  calls.length = 0;
  await repository.list('contracts', { page: 1, limit: 20, progress: 'inProgress', status: 'saved' });
  assert.ok(calls[0].sql.includes('t.status = ? AND t.progress = ?'));
  assert.deepEqual(calls[0].parameters, ['saved', 'inProgress']);
});

test('inactive users cannot access app data with an already issued user token', async (context) => {
  const { createApp } = require('../src/app');
  let dataCalls = 0;
  const app = createApp({
    appService: { async requireProfile() { throw new AppError(401, 'ACCOUNT_NOT_ACTIVE', '사용할 수 없는 계정입니다.'); }, async listContracts() { dataCalls += 1; return []; } },
    authService: {}, config, corsOrigins: [], pool: {},
  });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts`, { headers: { authorization: `Bearer ${jwt.sign({ type: 'access' }, secret, { subject: '7' })}` } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'ACCOUNT_NOT_ACTIVE');
  assert.equal(dataCalls, 0);
});

test('same-origin admin login works without a CORS allowlist entry and foreign origins remain blocked', async (context) => {
  const { createApp } = require('../src/app');
  const app = createApp({ appService: {}, authService: {}, config, corsOrigins: [], pool: {} });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (requestOrigin) => fetch(`${origin}/api/admin/auth/login`, {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'test-password' }),
  });
  const response = await send(origin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const blocked = await send('https://foreign.example.com');
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'CORS_NOT_ALLOWED');
  const oversized = await fetch(`${origin}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: '가'.repeat(100000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');
});

test('contract admin edits preserve the application lifecycle and do not resubmit old coordinates', async () => {
  const calls = [];
  const repository = new AdminRepository({}, { async updateContract(...arguments_) { calls.push(arguments_); return { id: '9' }; } });
  repository.get = async () => ({ id: '9', userId: '7' });
  repository.appRepository.getContract = async () => ({ id: '9', status: 'saved', siteAddress: '옛 주소', siteLatitude: 37.5, siteLongitude: 127.1, fee: 50000 });
  await repository.patch('contracts', '9', { siteAddress: '새 주소' });
  assert.equal(calls[0][0], '7');
  assert.equal(calls[0][1], '9');
  assert.equal(calls[0][2].siteAddress, '새 주소');
  assert.equal(calls[0][2].fee, 50000);
  assert.equal(Object.hasOwn(calls[0][2], 'siteLatitude'), false);
  assert.equal(Object.hasOwn(calls[0][2], 'siteLongitude'), false);
});

test('withdrawn accounts cannot be reactivated even if their legacy deleted_at is empty', async () => {
  let writes = 0;
  const repository = new AdminRepository({ async execute() { writes += 1; return [{}]; } });
  repository.get = async () => ({ id: '7', status: 'withdrawn', deletedAt: null });
  await assert.rejects(repository.patch('users', '7', { status: 'active' }), (error) => error.code === 'ACCOUNT_WITHDRAWN');
  assert.equal(writes, 0);
});

test('repository rejects pagination injection even when called outside the HTTP router', async () => {
  let calls = 0;
  const repository = new AdminRepository({ async execute() { calls += 1; return [[]]; } });
  await assert.rejects(repository.list('users', { page: 1, limit: '1; DROP TABLE users' }), (error) => error.code === 'INVALID_PAGINATION');
  assert.equal(calls, 0);
});

test('dashboard fills missing daily data and keeps contract turnover separate from unsettled work', async () => {
  const repository = new AdminRepository({ async execute(sql) {
    if (sql.includes('AS activeUsers')) return [[{ users: 5, activeUsers: 4, newUsers: 1 }]];
    if (sql.includes('AS contractAmount')) return [[{ contracts: 2, contractAmount: 700000 }]];
    if (sql.includes('AS schedules')) return [[{ schedules: 3 }]];
    if (sql.includes('AS pendingInquiries')) return [[{ pendingInquiries: 1 }]];
    if (sql.includes('AS unpaidAmount')) return [[{ unpaidAmount: 300000 }]];
    if (sql.includes('DATE_FORMAT') && sql.includes('FROM users')) return [[{ date: '2026-10-02', users: 1 }]];
    if (sql.includes('DATE_FORMAT') && sql.includes('FROM contracts')) return [[{ date: '2026-10-01', contracts: 2, amount: 700000 }]];
    if (sql.includes('progress AS status')) return [[{ status: 'scheduled', count: 2 }]];
    if (sql.includes('GROUP BY category')) return [[{ category: '스카이', count: 3 }]];
    throw new Error(`Unexpected query: ${sql}`);
  } });
  repository.list = async () => ({ items: [] });
  const result = await repository.dashboard({ from: '2026-10-01', to: '2026-10-03' });
  assert.equal(result.metrics.contractAmount, 700000);
  assert.equal(result.metrics.unpaidAmount, 300000);
  assert.equal(result.metrics.pendingInquiries, 1);
  assert.deepEqual(result.series, [
    { date: '2026-10-01', users: 0, contracts: 2, amount: 700000 },
    { date: '2026-10-02', users: 1, contracts: 0, amount: 0 },
    { date: '2026-10-03', users: 0, contracts: 0, amount: 0 },
  ]);
});
