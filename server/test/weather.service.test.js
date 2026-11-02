const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');

const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');
const {
  KmaWeatherProvider,
  WeatherService,
  getUltraSrtNcstBase,
  getVilageFcstBase,
  latLonToKmaGrid,
} = require('../src/services/weather.service');

const now = new Date('2026-08-23T00:10:00.000Z'); // 09:10 KST

const responseWithItems = (items) => ({
  ok: true,
  async json() {
    return {
      response: {
        body: { items: { item: items } },
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      },
    };
  },
});

test('KMA coordinates and KST forecast issue times are calculated deterministically', () => {
  assert.deepEqual(latLonToKmaGrid(37.5665, 126.978), { x: 60, y: 127 });
  assert.deepEqual(getUltraSrtNcstBase(now), { baseDate: '20260823', baseTime: '0800' });
  assert.deepEqual(getVilageFcstBase(now), { baseDate: '20260823', baseTime: '0800' });

  const justAfterMidnightKst = new Date('2026-08-22T15:10:00.000Z');
  assert.deepEqual(getUltraSrtNcstBase(justAfterMidnightKst), { baseDate: '20260822', baseTime: '2300' });
  assert.deepEqual(getVilageFcstBase(justAfterMidnightKst), { baseDate: '20260822', baseTime: '2300' });
});

test('KMA provider returns a stable configuration error without an API key', async () => {
  const provider = new KmaWeatherProvider({ apiKey: '' });
  await assert.rejects(
    () => provider.getWeather({ lat: 37.5665, lon: 126.978 }),
    (error) => error instanceof AppError && error.status === 503 && error.code === 'WEATHER_NOT_CONFIGURED',
  );
});

test('KMA provider normalizes observed current weather and tomorrow forecast', async () => {
  const observedItems = [
    { category: 'T1H', obsrValue: '27.3' },
    { category: 'RN1', obsrValue: '강수없음' },
    { category: 'REH', obsrValue: '62' },
    { category: 'PTY', obsrValue: '0' },
    { category: 'WSD', obsrValue: '2.3' },
  ];
  const forecastItems = [
    { category: 'SKY', fcstDate: '20260823', fcstTime: '0900', fcstValue: '3' },
    { category: 'PTY', fcstDate: '20260823', fcstTime: '0900', fcstValue: '0' },
    { category: 'TMP', fcstDate: '20260823', fcstTime: '0900', fcstValue: '28' },
    { category: 'TMN', fcstDate: '20260824', fcstTime: '0300', fcstValue: '21' },
    { category: 'TMP', fcstDate: '20260824', fcstTime: '0300', fcstValue: '21' },
    { category: 'POP', fcstDate: '20260824', fcstTime: '0300', fcstValue: '20' },
    { category: 'SKY', fcstDate: '20260824', fcstTime: '1200', fcstValue: '4' },
    { category: 'PTY', fcstDate: '20260824', fcstTime: '1200', fcstValue: '1' },
    { category: 'POP', fcstDate: '20260824', fcstTime: '1200', fcstValue: '70' },
    { category: 'TMP', fcstDate: '20260824', fcstTime: '1200', fcstValue: '25' },
    { category: 'TMX', fcstDate: '20260824', fcstTime: '1500', fcstValue: '30' },
    { category: 'TMP', fcstDate: '20260824', fcstTime: '1500', fcstValue: '30' },
  ];
  const requestedUrls = [];
  const provider = new KmaWeatherProvider({
    apiKey: 'server-only-test-key',
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      return String(url).includes('getUltraSrtNcst')
        ? responseWithItems(observedItems)
        : responseWithItems(forecastItems);
    },
    now: () => now,
  });

  const weather = await provider.getWeather({ lat: 37.5665, lon: 126.978 });

  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].searchParams.get('authKey'), 'server-only-test-key');
  assert.equal(requestedUrls[0].searchParams.get('base_date'), '20260823');
  assert.equal(requestedUrls[0].searchParams.get('base_time'), '0800');
  assert.equal(weather.current.temperature, 27.3);
  assert.equal(weather.current.condition, '구름 조금');
  assert.equal(weather.current.label, '구름 조금');
  assert.equal(weather.current.emoji, '⛅');
  assert.equal(weather.current.observedAt, '2026-08-23T08:00:00+09:00');
  assert.equal(weather.tomorrow.date, '2026-08-24');
  assert.equal(weather.tomorrow.label, '비');
  assert.equal(weather.tomorrow.condition, '비');
  assert.equal(weather.tomorrow.emoji, '🌧️');
  assert.equal(weather.tomorrow.minTemperature, 21);
  assert.equal(weather.tomorrow.maxTemperature, 30);
  assert.equal(weather.tomorrow.precipitationProbability, 70);
});

test('KMA provider still returns current observations when tomorrow forecast is temporarily unavailable', async () => {
  const provider = new KmaWeatherProvider({
    apiKey: 'server-only-test-key',
    fetchImpl: async (url) => {
      if (String(url).includes('getUltraSrtNcst')) {
        return responseWithItems([
          { category: 'T1H', obsrValue: '26' },
          { category: 'PTY', obsrValue: '0' },
          { category: 'WSD', obsrValue: '1.4' },
        ]);
      }
      throw new Error('KMA forecast is temporarily unavailable');
    },
    now: () => now,
  });

  const weather = await provider.getWeather({ lat: 37.5665, lon: 126.978 });
  assert.equal(weather.current.temperature, 26);
  assert.equal(weather.current.condition, '날씨 정보');
  assert.equal(weather.tomorrow, null);
});

test('weather service deduplicates requests, caches by KMA grid, and serves a bounded stale fallback', async () => {
  let currentTime = now.getTime();
  let calls = 0;
  const provider = {
    getCacheKey() {
      return 'kma:60:127';
    },
    async getWeather() {
      calls += 1;
      if (calls > 1) throw new AppError(502, 'WEATHER_PROVIDER_UNAVAILABLE', 'provider unavailable');
      return { current: { emoji: '☀️', temperature: 27 }, tomorrow: { emoji: '⛅' } };
    },
  };
  const service = new WeatherService({
    cacheTtlMs: 60_000,
    now: () => new Date(currentTime),
    provider,
    staleTtlMs: 5 * 60_000,
  });

  const [first, concurrent] = await Promise.all([
    service.getWeather({ lat: 37.5665, lon: 126.978 }),
    service.getWeather({ lat: 37.5665, lon: 126.978 }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.cache.cached, false);
  assert.equal(concurrent.cache.cached, false);

  const fresh = await service.getWeather({ lat: 37.56, lon: 126.97 });
  assert.equal(calls, 1);
  assert.equal(fresh.cache.cached, true);
  assert.equal(fresh.cache.stale, false);

  currentTime += 61_000;
  const stale = await service.getWeather({ lat: 37.56, lon: 126.97 });
  assert.equal(calls, 2);
  assert.equal(stale.cache.cached, true);
  assert.equal(stale.cache.stale, true);
});

const jwtSecret = 'weather-route-test-secret-that-is-at-least-thirty-two-characters';
const token = () => jwt.sign({ type: 'access' }, jwtSecret, { subject: '7' });
const routeConfig = { jwt: { secret: jwtSecret } };
const routeAppService = { async getTerms() { return null; } };
const routePool = { async execute() { return [[{ ok: 1 }]]; } };
let requestedCoordinates;
const routeWeatherService = {
  async getWeather(coordinates) {
    requestedCoordinates = coordinates;
    return { current: { emoji: '☀️', temperature: 27 }, tomorrow: { emoji: '⛅' } };
  },
};
const routeApp = createApp({
  appService: routeAppService,
  authService: {},
  config: routeConfig,
  corsOrigins: [],
  pool: routePool,
  weatherService: routeWeatherService,
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

test('weather route requires authentication, validates coordinates, and delegates to the server provider', async () => {
  const unauthenticated = await fetch(`${routeBaseUrl}/api/weather?lat=37.5665&lon=126.978`);
  assert.equal(unauthenticated.status, 401);

  const invalid = await fetch(`${routeBaseUrl}/api/weather?lat=wrong&lon=126.978`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  const invalidBody = await invalid.json();
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.error.code, 'VALIDATION_ERROR');

  const response = await fetch(`${routeBaseUrl}/api/weather?lat=37.5665&lon=126.978`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(requestedCoordinates, { lat: 37.5665, lon: 126.978 });
  assert.equal(response.headers.get('cache-control'), 'private, max-age=60');
  assert.equal(body.data.current.temperature, 27);
});
