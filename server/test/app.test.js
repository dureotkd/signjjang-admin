const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { createApp } = require('../src/app');

const authService = {
  async checkSignupBusiness(payload) {
    signupBusinessPayload = payload;
    return { available: true };
  },
  async findPhone() {
    return { maskedPhone: '010****5678' };
  },
  async login({ phone }) {
    return { accessToken: 'test-token', user: { id: '1', phone } };
  },
  async resetPassword() {
    return { message: '비밀번호가 변경되었습니다.' };
  },
  async sendSmsCode() {
    return { devCode: '123456', expiresInSeconds: 180 };
  },
  async signup(payload) {
    signupPayload = payload;
    return { accessToken: 'test-token', user: { id: '1', phone: '01012345678' } };
  },
  async verifySmsCode() {
    return { verificationToken: 'verification-token' };
  },
};

const pool = { async execute() { return [[{ ok: 1 }]]; } };
const jwtSecret = 'test-secret-that-is-at-least-thirty-two-characters';
let deliveredContract;
let importedContacts;
let signupPayload;
let signupBusinessPayload;
let equipmentPayload;
const appService = {
  async sendDocuments(userId, delivery) {
    return { userId, ...delivery, sentDocumentIds: delivery.documentIds.map(String), remainingDocumentIds: [] };
  },
  async replaceEquipments(userId, equipments) {
    equipmentPayload = { userId, equipments };
    return equipments;
  },
  async bootstrap(userId) {
    return { contracts: [], equipments: [], schedules: [], user: { id: String(userId) } };
  },
  async getTerms(slug) {
    return { body: '약관', slug, title: '서비스 이용약관', version: '1.0' };
  },
  async createContract(userId, contract) {
    return { ...contract, id: '11', ownerId: String(userId) };
  },
  async createSchedule(userId, schedule) {
    return { ...schedule, id: '21', ownerId: String(userId) };
  },
  async createContractDelivery(userId, contractId, delivery) {
    deliveredContract = { contractId, delivery, userId };
    return { id: '31', status: 'sent' };
  },
  async importContacts(userId, contacts) {
    importedContacts = { contacts, userId };
    return { imported: contacts.length, skipped: 0 };
  },
};
const config = { jwt: { secret: jwtSecret } };
const app = createApp({
  appService,
  authService,
  config,
  corsOrigins: ['http://localhost:8081', 'http://localhost:8082'],
  pool,
});
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('health check returns database status', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.database, 'connected');
});

test('document delivery requires auth and validates IDs and the recipient before sending', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const send = (body, authenticated = true) => fetch(`${baseUrl}/api/documents/deliveries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal((await send({ documentIds: ['1'], recipientPhone: '01012345678' }, false)).status, 401);
  for (const body of [
    { documentIds: [], recipientPhone: '01012345678' },
    { documentIds: ['oops'], recipientPhone: '01012345678' },
    { documentIds: ['1'], recipientPhone: '123' },
    { documentIds: Array.from({ length: 19 }, (_, index) => index + 1), recipientPhone: '01012345678' },
  ]) assert.equal((await send(body)).status, 400);
  const response = await send({ documentIds: ['1', '2', '1'], recipientPhone: '010-1234-5678' });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.userId, 7);
  assert.equal(data.recipientPhone, '01012345678');
  assert.deepEqual(data.sentDocumentIds, ['1', '2']);
});

test('login normalizes phone and returns a token', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    body: JSON.stringify({ password: 'Password1!', phone: '010-1234-5678' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.accessToken, 'test-token');
  assert.equal(body.data.user.phone, '01012345678');
});

test('invalid login payload returns a validation error', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    body: JSON.stringify({ password: '', phone: '123' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('CORS allows the second Expo development port', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json', origin: 'http://localhost:8082' },
    method: 'POST',
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8082');
});

test('bootstrap requires an access token', async () => {
  const response = await fetch(`${baseUrl}/api/app/bootstrap`);
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
});

test('bootstrap returns user-scoped application data', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.user.id, '7');
  assert.deepEqual(body.data.contracts, []);
});

test('previously issued access tokens remain valid after their former expiry date', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { expiresIn: '-1s', subject: '8' });
  const response = await fetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.user.id, '8');
});

test('authenticated user can create a validated contract', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/contracts`, {
    body: JSON.stringify({
      confirmerName: '김현장',
      confirmerPhone: '010-7777-1212',
      documentDate: '2026-08-04',
      endDate: '2026-08-04',
      fee: 420000,
      progress: 'scheduled',
      startDate: '2026-08-04',
      status: 'saved',
      type: '건설기계사용확인서',
    }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.id, '11');
  assert.equal(body.data.ownerId, '7');
  assert.equal(body.data.confirmerName, '김현장');
  assert.equal(body.data.confirmerPhone, '010-7777-1212');
  assert.equal(body.data.documentDate, '2026-08-04');
});

test('signup accepts a missing referral code so users can skip it', async () => {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    body: JSON.stringify({
      birthYear: 1990,
      companyName: '싸인짱건설',
      email: 'member@example.com',
      equipments: ['굴삭기'],
      fullName: '홍길동',
      gender: 'male',
      marketingAgreed: false,
      password: 'Password1!',
      phone: '010-1234-5678',
      smsVerificationToken: 'test-verification-token',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(signupPayload.referralCode, undefined);
});

test('signup business check validates and normalizes fields before the next step', async () => {
  signupBusinessPayload = undefined;
  const response = await fetch(`${baseUrl}/api/auth/signup/check-business`, {
    body: JSON.stringify({
      companyName: ' 싸인짱건설 ', email: ' member@example.com ', phone: '010-1234-5678',
      smsVerificationToken: 'test-verification-token',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { available: true }, success: true });
  assert.deepEqual(signupBusinessPayload, {
    companyName: '싸인짱건설', email: 'member@example.com', phone: '01012345678',
    smsVerificationToken: 'test-verification-token',
  });
});

test('signup business check rejects malformed fields without reaching the service', async () => {
  const valid = {
    companyName: '싸인짱건설', email: 'member@example.com', phone: '01012345678',
    smsVerificationToken: 'test-verification-token',
  };
  for (const [field, value] of [
    ['companyName', ' '], ['companyName', '가'.repeat(101)],
    ['email', 'a@b.c'], ['email', 'a..b@example.com'], ['email', `${'a'.repeat(179)}@example.com`],
    ['phone', '12345678901'], ['smsVerificationToken', ''],
  ]) {
    signupBusinessPayload = undefined;
    const response = await fetch(`${baseUrl}/api/auth/signup/check-business`, {
      body: JSON.stringify({ ...valid, [field]: value }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();
    assert.equal(response.status, 400, `${field}: ${value}`);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details.some((issue) => issue.field === field), true);
    assert.equal(signupBusinessPayload, undefined);
  }
});

test('signup accepts restored sky equipment and trims category names', async () => {
  for (const category of ['스카이', ' 스카이 ', 'sky', ' SKY ']) {
    signupPayload = undefined;
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      body: JSON.stringify({
        companyName: '테스트 장비회사', equipments: ['지게차', category], fullName: '테스트 기사',
        password: 'Password1!', phone: '01012345678', smsVerificationToken: 'test-verification-token',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();
    assert.equal(response.status, 201, category);
    assert.equal(body.success, true);
    assert.equal(signupPayload.equipments[1], category.trim());
  }
});

test('signup preserves multiple specifications for the same equipment category and legacy entries', async () => {
  signupPayload = undefined;
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    body: JSON.stringify({
      companyName: '테스트 장비회사', fullName: '테스트 기사', password: 'Password1!', phone: '01012345678',
      smsVerificationToken: 'test-verification-token',
      equipments: [{ category: ' 지게차 ', tonnage: ' 1톤 ' }, { category: '지게차', tonnage: '2톤' }, ' 스카이 '],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(signupPayload.equipments, [
    { category: '지게차', tonnage: '1톤' }, { category: '지게차', tonnage: '2톤' }, '스카이',
  ]);
});

test('signup rejects invalid equipment specifications and more than 20 equipment entries', async () => {
  for (const equipments of [
    [{ category: '지게차' }],
    [{ category: '지게차', tonnage: '' }],
    [{ category: '지게차', tonnage: ' ' }],
    [{ category: '지게차', tonnage: '가'.repeat(51) }],
    [{ category: '지게차', tonnage: 1 }],
    [{ category: ' ', tonnage: '1톤' }],
    [{ category: '가'.repeat(51), tonnage: '1톤' }],
    Array.from({ length: 21 }, () => ({ category: '지게차', tonnage: '1톤' })),
  ]) {
    signupPayload = undefined;
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      body: JSON.stringify({
        companyName: '테스트 장비회사', fullName: '테스트 기사', password: 'Password1!', phone: '01012345678',
        smsVerificationToken: 'test-verification-token', equipments,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(equipments));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details.some((issue) => issue.field.startsWith('equipments')), true);
    assert.equal(signupPayload, undefined);
  }
});

test('signup remains compatible with an omitted equipment list', async () => {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    body: JSON.stringify({
      companyName: '테스트 장비회사', fullName: '테스트 기사', password: 'Password1!', phone: '01012345678',
      smsVerificationToken: 'test-verification-token',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 201);
  assert.deepEqual(signupPayload.equipments, []);
});

test('equipment replacement accepts restored sky equipment', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  for (const category of ['스카이', ' 스카이 ', 'sky', ' SKY ']) {
    equipmentPayload = undefined;
    const response = await fetch(`${baseUrl}/api/equipments`, {
      body: JSON.stringify([{ category: '지게차' }, { category }]),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'PUT',
    });
    const body = await response.json();
    assert.equal(response.status, 200, category);
    assert.equal(body.success, true);
    assert.equal(equipmentPayload.equipments[1].category, category.trim());
  }
});

test('equipment replacement still accepts other categories and clearing owned equipment', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  for (const categories of [['지게차', '크레인', '포크레인', '사다리차', '굴삭기'], []]) {
    const response = await fetch(`${baseUrl}/api/equipments`, {
      body: JSON.stringify(categories.map((category) => ({ category: ` ${category} ` }))),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'PUT',
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(equipmentPayload.userId, 7);
    assert.deepEqual(body.data.map((equipment) => equipment.category), categories);
  }
});

test('authenticated user can send a captured contract image by MMS', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const form = new FormData();
  form.append('recipientName', '홍길동');
  form.append('recipientPhone', '010-9876-5432');
  form.append('recipientType', '확인자');
  form.append('contractImage', new Blob(['captured contract'], { type: 'image/png' }), 'contract.png');
  const response = await fetch(`${baseUrl}/api/contracts/11/deliveries`, {
    body: form,
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.data.status, 'sent');
  assert.equal(deliveredContract.userId, 7);
  assert.equal(deliveredContract.contractId, 11);
  assert.equal(deliveredContract.delivery.recipientPhone, '01098765432');
  assert.equal(deliveredContract.delivery.image.mimetype, 'image/png');
});

test('contract and document MMS accept complete contact numbers and reject malformed recipients', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const sendContract = (phone) => {
    const form = new FormData();
    form.append('recipientName', '장비왕');
    form.append('recipientPhone', phone);
    form.append('recipientType', '오더주');
    form.append('contractImage', new Blob(['captured contract'], { type: 'image/png' }), 'contract.png');
    return fetch(`${baseUrl}/api/contracts/11/deliveries`, {
      body: form,
      headers: { authorization: `Bearer ${token}` },
      method: 'POST',
    });
  };
  const sendDocuments = (phone) => fetch(`${baseUrl}/api/documents/deliveries`, {
    body: JSON.stringify({ documentIds: ['1'], recipientPhone: phone }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });

  for (const phone of ['010-1234-5678', '02-1234-5678', '031-123-4567', '070-1234-5678', '0504-1234-5678', '1588-8811', '1644-1234', '1800-1234']) {
    assert.equal((await sendContract(phone)).status, 202, phone);
    assert.equal(deliveredContract.delivery.recipientPhone, phone.replace(/\D/g, ''), phone);
    const documents = await sendDocuments(phone);
    assert.equal(documents.status, 200, phone);
    assert.equal((await documents.json()).data.recipientPhone, phone.replace(/\D/g, ''), phone);
  }
  for (const phone of ['', '010-123-45', '02-123-456', '1588', '1588-881', '1588-88111', '1234-5678', '0101234567890123']) {
    deliveredContract = undefined;
    assert.equal((await sendContract(phone)).status, 400, phone);
    assert.equal(deliveredContract, undefined, phone);
    assert.equal((await sendDocuments(phone)).status, 400, phone);
  }
});

test('authenticated user can import device contacts in bulk', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/contacts/import`, {
    body: JSON.stringify([
      { contactName: '홍길동', phone: '010-9876-5432', tradeName: '대한건설' },
      { contactName: '현장 사무실', phone: '02-1234-5678', tradeName: '서울 현장' },
    ]),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { imported: 2, skipped: 0 });
  assert.equal(importedContacts.userId, 7);
  assert.deepEqual(importedContacts.contacts.map((contact) => contact.phone), ['01098765432', '0212345678']);
});

test('schedule API rejects invalid dates before database access', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/schedules`, {
    body: JSON.stringify({ date: 'tomorrow', fee: 0, settlement: '미수금', status: 'scheduled' }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('schedule API rejects impossible calendar dates, not only malformed strings', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  for (const date of ['2026-02-30', '2026-13-01', '2025-02-29']) {
    const response = await fetch(`${baseUrl}/api/schedules`, {
      body: JSON.stringify({ date, fee: 300000, settlement: '미수금', status: 'ended' }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 400, date);
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  }
});

test('contract API rejects a work period that ends before it starts', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/contracts`, {
    body: JSON.stringify({ endDate: '2026-09-07', fee: 500000, progress: 'scheduled',
      startDate: '2026-09-08', status: 'completed', type: '건설기계사용확인서' }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});

test('a standalone past work log retains contact, tenant and usage information without a contract', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/schedules`, {
    body: JSON.stringify({ date: '2026-09-05', fee: 300000, settlement: '미수금', status: 'ended',
      orderer: '구름스카이', orderPhone: '010.5489.3899', tenant: 'km모빌', sitePhone: '',
      siteAddress: '원남리1196-1', siteName: '논산cctv현장', workContent: 'cctv시공',
      usagePeriods: [], usageHours: '2', hourWork: '', nightWork: '' }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.contractId, undefined);
  assert.equal(body.data.orderer, '구름스카이');
  assert.equal(body.data.tenant, 'km모빌');
  assert.equal(body.data.sitePhone, '');
  assert.equal(body.data.workContent, 'cctv시공');
  assert.equal(body.data.usageHours, '2');
});

test('a contract can be saved with its tenant and site contact still unknown', async () => {
  const token = jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
  const response = await fetch(`${baseUrl}/api/contracts`, {
    body: JSON.stringify({ endDate: '2026-09-11', fee: 600000, progress: 'scheduled',
      startDate: '2026-09-11', status: 'completed', type: '건설기계사용확인서', tenant: '', sitePhone: '',
      siteName: '청주후레싱 시공 현장', siteAddress: '명암동 9-9', orderer: '강변지게차' }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.tenant, '');
  assert.equal(body.data.sitePhone, '');
});

test('terms content is public for signup screens', async () => {
  const response = await fetch(`${baseUrl}/api/terms/service`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.slug, 'service');
});
