const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');
const { AppRepository, toContract, toSchedule } = require('../src/repositories/app.repository');
const { AppService } = require('../src/services/app.service');
const { KakaoAddressGeocoder } = require('../src/services/site-geocoder.service');

test('Kakao address geocoder uses server-side authorization and normalizes a parenthesized address', async () => {
  let requested;
  const geocoder = new KakaoAddressGeocoder({
    apiKey: 'server-only-kakao-key',
    fetchImpl: async (url, options) => {
      requested = { options, url: new URL(url) };
      return {
        ok: true,
        async json() {
          return {
            documents: [{
              address_name: '서울 강남구 테헤란로 123',
              x: '127.027621',
              y: '37.497942',
            }],
          };
        },
      };
    },
  });

  const result = await geocoder.geocode(' 서울 강남구 테헤란로 123 (역삼동) ');

  assert.equal(requested.options.headers.authorization, 'KakaoAK server-only-kakao-key');
  assert.equal(requested.url.searchParams.get('query'), '서울 강남구 테헤란로 123');
  assert.equal(requested.url.searchParams.get('analyze_type'), 'exact');
  assert.equal(result.siteLatitude, 37.497942);
  assert.equal(result.siteLongitude, 127.027621);
  assert.equal(result.provider, 'kakao');
});

test('Kakao address geocoder returns a clear configuration error without a key', async () => {
  const geocoder = new KakaoAddressGeocoder({ apiKey: '' });
  await assert.rejects(
    () => geocoder.geocode('서울 강남구 테헤란로 123'),
    (error) => error instanceof AppError && error.status === 503 && error.code === 'SITE_GEOCODER_NOT_CONFIGURED',
  );
});

test('Kakao address geocoder falls back to one unambiguous similar result but rejects ambiguous matches', async () => {
  const requestedTypes = [];
  const geocoder = new KakaoAddressGeocoder({
    apiKey: 'server-only-kakao-key',
    fetchImpl: async (url) => {
      const analyzeType = new URL(url).searchParams.get('analyze_type');
      requestedTypes.push(analyzeType);
      return {
        ok: true,
        async json() {
          if (analyzeType === 'exact') return { documents: [], meta: { total_count: 0 } };
          return {
            documents: [{ address_name: '서울 강남구 테헤란로 123', x: '127.027621', y: '37.497942' }],
            meta: { total_count: 1 },
          };
        },
      };
    },
  });

  const fallback = await geocoder.geocode('서울 강남구 테헤란로 123');
  assert.deepEqual(requestedTypes, ['exact', 'similar']);
  assert.equal(fallback.siteLatitude, 37.497942);

  const ambiguous = new KakaoAddressGeocoder({
    apiKey: 'server-only-kakao-key',
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        return new URL(url).searchParams.get('analyze_type') === 'exact'
          ? { documents: [], meta: { total_count: 0 } }
          : {
            documents: [
              { address_name: '서울 강남구 테헤란로 123', x: '127.027621', y: '37.497942' },
              { address_name: '서울 강남구 테헤란로 125', x: '127.028000', y: '37.498000' },
            ],
            meta: { total_count: 2 },
          };
      },
    }),
  });
  assert.equal(await ambiguous.geocode('서울 강남구 테헤란로'), null);
});

test('stored coordinates are preferred without calling the geocoder', async () => {
  let geocoderCalls = 0;
  let persisted = 0;
  const repository = {
    async getContract() {
      return {
        id: '11',
        siteAddress: '서울 강남구 테헤란로 123',
        siteLatitude: 37.497942,
        siteLongitude: 127.027621,
      };
    },
    async updateContractSiteCoordinates() {
      persisted += 1;
      return null;
    },
  };
  const service = new AppService(repository, null, {
    async geocode() {
      geocoderCalls += 1;
      return null;
    },
  });

  const location = await service.resolveContractSiteLocation(7, 11);
  assert.deepEqual(location, {
    siteLatitude: 37.497942,
    siteLongitude: 127.027621,
    source: 'stored',
  });
  assert.equal(geocoderCalls, 0);
  assert.equal(persisted, 0);
});

test('live resolver does not save coordinates after the saved address changes', async () => {
  let expectedSiteAddress;
  const repository = {
    async getContract() {
      return { id: '11', siteAddress: '서울 강남구 테헤란로 123' };
    },
    async updateContractSiteCoordinates(_userId, _contractId, _coordinates, options) {
      expectedSiteAddress = options.expectedSiteAddress;
      return null;
    },
  };
  const service = new AppService(repository, null, {
    async geocode() {
      return { siteLatitude: 37.497942, siteLongitude: 127.027621 };
    },
  });

  await assert.rejects(
    () => service.resolveContractSiteLocation(7, 11),
    (error) => error instanceof AppError && error.status === 409 && error.code === 'SITE_ADDRESS_CHANGED',
  );
  assert.equal(expectedSiteAddress, '서울 강남구 테헤란로 123');
});

test('coordinate-only persistence saves a complete pair or explicitly clears it without a contract rewrite', async () => {
  const writes = [];
  const repository = {
    async updateContractSiteCoordinates(_userId, _contractId, coordinates) {
      writes.push(coordinates);
      return { id: '11' };
    },
  };
  const service = new AppService(repository, null);

  assert.deepEqual(
    await service.updateContractSiteLocation(7, 11, { siteLatitude: 37.497942, siteLongitude: 127.027621 }),
    { siteLatitude: 37.497942, siteLongitude: 127.027621 },
  );
  assert.deepEqual(
    await service.updateContractSiteLocation(7, 11, { siteLatitude: null, siteLongitude: null }),
    { siteLatitude: null, siteLongitude: null },
  );
  assert.deepEqual(writes, [
    { siteLatitude: 37.497942, siteLongitude: 127.027621 },
    null,
  ]);
});

test('contract updates retain a coordinate pair for the same address and clear it when the address changes', async () => {
  const existing = {
    id: '11',
    siteAddress: '서울 강남구 테헤란로 123',
    siteLatitude: 37.497942,
    siteLongitude: 127.027621,
  };
  const updates = [];
  const repository = {
    async getContract() {
      return existing;
    },
    async updateContract(_userId, _contractId, contract) {
      updates.push(contract);
      return contract;
    },
  };
  const service = new AppService(repository, null);

  await service.updateContract(7, 11, {
    fee: 100,
    siteAddress: '서울 강남구 테헤란로 123',
    type: '작업확인서',
  });
  assert.equal(updates[0].siteLatitude, 37.497942);
  assert.equal(updates[0].siteLongitude, 127.027621);

  await service.updateContract(7, 11, {
    fee: 100,
    siteAddress: '서울 서초구 서초대로 77',
    type: '작업확인서',
  });
  assert.equal(Object.hasOwn(updates[1], 'siteLatitude'), false);
  assert.equal(Object.hasOwn(updates[1], 'siteLongitude'), false);
});

test('a schedule created from a contract inherits its saved coordinates', async () => {
  let created;
  const repository = {
    async getContract() {
      return {
        siteAddress: '서울 강남구 테헤란로 123',
        siteLatitude: 37.497942,
        siteLongitude: 127.027621,
      };
    },
    async createSchedule(_userId, schedule) {
      created = schedule;
      return schedule;
    },
  };
  const service = new AppService(repository, null);

  await service.createSchedule(7, { contractId: '11', siteAddress: '서울 강남구 테헤란로 123' });
  assert.equal(created.siteLatitude, 37.497942);
  assert.equal(created.siteLongitude, 127.027621);
});

test('schedule coordinate inheritance clears the pair when the linked contract has another address', async () => {
  let created;
  let updated;
  const repository = {
    async createSchedule(_userId, schedule) {
      created = schedule;
      return schedule;
    },
    async getContract() {
      return {
        siteAddress: '서울 서초구 서초대로 77',
        siteLatitude: 37.491,
        siteLongitude: 127.007,
      };
    },
    async getSchedule() {
      return {
        contractId: '11',
        siteAddress: '서울 강남구 테헤란로 123',
        siteLatitude: 37.497942,
        siteLongitude: 127.027621,
      };
    },
    async updateSchedule(_userId, _scheduleId, schedule) {
      updated = schedule;
      return schedule;
    },
  };
  const service = new AppService(repository, null);

  await service.createSchedule(7, { contractId: '22', siteAddress: '서울 강남구 테헤란로 123' });
  assert.equal(Object.hasOwn(created, 'siteLatitude'), false);
  assert.equal(Object.hasOwn(created, 'siteLongitude'), false);

  await service.updateSchedule(7, 21, { contractId: '22', siteAddress: '서울 강남구 테헤란로 123' });
  assert.equal(Object.hasOwn(updated, 'siteLatitude'), false);
  assert.equal(Object.hasOwn(updated, 'siteLongitude'), false);
});

test('repository serialization prefers coordinate columns and keeps legacy payload coordinates compatible', () => {
  const contract = toContract({
    fee: '100',
    id: 11,
    payload: JSON.stringify({
      siteAddress: '서울 강남구 테헤란로 123',
      siteLatitude: 35,
      siteLongitude: 126,
    }),
    progress: 'scheduled',
    site_latitude: '37.497942',
    site_longitude: '127.027621',
    start_date: '2026-08-24',
    status: 'saved',
    type: '작업확인서',
    updated_at: '2026-08-24T00:00:00.000Z',
  });
  assert.equal(contract.siteLatitude, 37.497942);
  assert.equal(contract.siteLongitude, 127.027621);

  const schedule = toSchedule({
    contract_id: null,
    fee: '100',
    id: 21,
    payload: JSON.stringify({ siteLatitude: 37.5, siteLongitude: 127.1 }),
    settlement: '미수금',
    site_latitude: null,
    site_longitude: null,
    status: 'scheduled',
    work_date: '2026-08-24',
  });
  assert.equal(schedule.siteLatitude, 37.5);
  assert.equal(schedule.siteLongitude, 127.1);
});

test('repository coordinate update atomically preserves the saved address and guards a resolver read', async () => {
  let updateStatement;
  let updateParameters;
  const pool = {
    async execute(statement, parameters) {
      if (statement.startsWith('UPDATE contracts')) {
        updateStatement = statement;
        updateParameters = parameters;
        return [{ affectedRows: 1 }];
      }
      if (statement.includes('FROM contracts WHERE id = ?')) {
        return [[{
          fee: '100',
          id: 11,
          payload: JSON.stringify({ memo: 'keep this', siteAddress: '서울 강남구 테헤란로 123' }),
          progress: 'scheduled',
          site_latitude: '37.497942',
          site_longitude: '127.027621',
          start_date: '2026-08-24',
          status: 'saved',
          type: '작업확인서',
          updated_at: '2026-08-24T00:00:00.000Z',
        }]];
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
  };
  const repository = new AppRepository(pool);

  await repository.updateContractSiteCoordinates(
    7,
    11,
    { siteLatitude: 37.497942, siteLongitude: 127.027621 },
    { expectedSiteAddress: '서울 강남구 테헤란로 123' },
  );

  assert.match(updateStatement, /JSON_SET\(JSON_REMOVE\(payload/);
  assert.match(updateStatement, /JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.siteAddress'\)\) <=> \?/);
  assert.doesNotMatch(updateStatement, /site_address/i);
  assert.deepEqual(updateParameters, [
    37.497942,
    127.027621,
    37.497942,
    127.027621,
    11,
    7,
    '서울 강남구 테헤란로 123',
  ]);
});

const jwtSecret = 'site-location-route-test-secret-that-is-at-least-thirty-two-characters';
const token = () => jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
let createdContract;
let resolvedContract;
let savedContractLocation;
let savedScheduleLocation;
const appService = {
  async createContract(_userId, contract) {
    createdContract = contract;
    return { ...contract, id: '11' };
  },
  async getTerms() {
    return null;
  },
  async resolveContractSiteLocation(userId, contractId) {
    resolvedContract = { contractId, userId };
    return { siteLatitude: 37.497942, siteLongitude: 127.027621, source: 'stored' };
  },
  async updateContractSiteLocation(userId, contractId, location) {
    savedContractLocation = { contractId, location, userId };
    return location;
  },
  async updateScheduleSiteLocation(userId, scheduleId, location) {
    savedScheduleLocation = { location, scheduleId, userId };
    return location;
  },
};
const routeApp = createApp({
  appService,
  authService: {},
  config: { jwt: { secret: jwtSecret } },
  corsOrigins: [],
  pool: { async execute() { return [[{ ok: 1 }]]; } },
});
let routeServer;
let routeBaseUrl;

before(async () => {
  await new Promise((resolve) => {
    routeServer = routeApp.listen(0, '127.0.0.1', () => {
      routeBaseUrl = `http://127.0.0.1:${routeServer.address().port}`;
      resolve();
    });
  });
});

after(async () => new Promise((resolve) => routeServer.close(resolve)));

const contractPayload = (coordinates) => ({
  endDate: '2026-08-24',
  fee: 420000,
  progress: 'scheduled',
  startDate: '2026-08-24',
  status: 'saved',
  type: '작업확인서',
  ...coordinates,
});

test('contract schema accepts an explicit null coordinate pair and rejects a partial pair', async () => {
  const accepted = await fetch(`${routeBaseUrl}/api/contracts`, {
    body: JSON.stringify(contractPayload({ siteLatitude: null, siteLongitude: null })),
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(accepted.status, 201);
  assert.equal(createdContract.siteLatitude, null);
  assert.equal(createdContract.siteLongitude, null);

  const rejected = await fetch(`${routeBaseUrl}/api/contracts`, {
    body: JSON.stringify(contractPayload({ siteLatitude: 37.497942 })),
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 400);
  assert.equal(rejectedBody.error.code, 'VALIDATION_ERROR');
});

test('saved-address resolver endpoint is authenticated and delegates within the caller scope', async () => {
  const unauthenticated = await fetch(`${routeBaseUrl}/api/contracts/11/site-location`, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(`${routeBaseUrl}/api/contracts/11/site-location`, {
    headers: { authorization: `Bearer ${token()}` },
    method: 'POST',
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(resolvedContract, { contractId: 11, userId: 7 });
  assert.equal(body.data.source, 'stored');
});

test('coordinate-only endpoints are authenticated, strict, and accept an explicit null pair', async () => {
  const unauthenticated = await fetch(`${routeBaseUrl}/api/contracts/11/site-location`, {
    body: JSON.stringify({ siteLatitude: 37.497942, siteLongitude: 127.027621 }),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  });
  assert.equal(unauthenticated.status, 401);

  const saved = await fetch(`${routeBaseUrl}/api/contracts/11/site-location`, {
    body: JSON.stringify({ siteLatitude: 37.497942, siteLongitude: 127.027621 }),
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    method: 'PUT',
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(savedContractLocation, {
    contractId: 11,
    location: { siteLatitude: 37.497942, siteLongitude: 127.027621 },
    userId: 7,
  });

  const cleared = await fetch(`${routeBaseUrl}/api/schedules/21/site-location`, {
    body: JSON.stringify({ siteLatitude: null, siteLongitude: null }),
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    method: 'PUT',
  });
  const clearedBody = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.deepEqual(savedScheduleLocation, {
    location: { siteLatitude: null, siteLongitude: null },
    scheduleId: 21,
    userId: 7,
  });
  assert.equal(clearedBody.data.siteLatitude, null);

  const rejected = await fetch(`${routeBaseUrl}/api/contracts/11/site-location`, {
    body: JSON.stringify({ siteAddress: '주소를 바꾸면 안 됩니다', siteLatitude: 37.497942, siteLongitude: 127.027621 }),
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    method: 'PUT',
  });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 400);
  assert.equal(rejectedBody.error.code, 'VALIDATION_ERROR');
});
