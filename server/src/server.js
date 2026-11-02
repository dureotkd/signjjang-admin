const { createApp } = require('./app');
const { config } = require('./config');
const { pool } = require('./db');
const { AuthRepository } = require('./repositories/auth.repository');
const { AppRepository } = require('./repositories/app.repository');
const { AppService } = require('./services/app.service');
const { AuthService } = require('./services/auth.service');
const { SmsService } = require('./services/sms.service');
const { KakaoAddressGeocoder } = require('./services/site-geocoder.service');
const { KmaWeatherProvider, WeatherService } = require('./services/weather.service');

const repository = new AuthRepository(pool);
const appRepository = new AppRepository(pool);
const smsService = new SmsService(config.sms);
const authService = new AuthService({ config, repository, smsService });
const siteGeocoder = new KakaoAddressGeocoder({
  apiKey: config.siteGeocoder.kakaoRestApiKey,
  baseUrl: config.siteGeocoder.kakaoLocalApiBaseUrl,
  timeoutMs: config.siteGeocoder.kakaoLocalApiTimeoutMs,
});
const appService = new AppService(appRepository, smsService, siteGeocoder);
const weatherProvider = new KmaWeatherProvider({
  apiKey: config.weather.kmaApiKey,
  baseUrl: config.weather.kmaBaseUrl,
  timeoutMs: config.weather.requestTimeoutMs,
});
const weatherService = new WeatherService({
  cacheTtlMs: config.weather.cacheTtlMs,
  provider: weatherProvider,
  staleTtlMs: config.weather.staleTtlMs,
});
const app = createApp({ appService, authService, config, corsOrigins: config.corsOrigins, pool, weatherService });

const server = app.listen(config.port, config.host, () => {
  console.info(`싸인짱 API 서버: http://${config.host}:${config.port}`);
});

pool.execute('SELECT 1')
  .then(() => console.info('[database] connection check passed'))
  .catch((error) => console.error(`[database] connection check failed: ${error.code ?? error.message}`));

const shutdown = async (signal) => {
  console.info(`${signal} 수신, 서버를 종료합니다.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
