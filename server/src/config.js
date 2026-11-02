const path = require('node:path');

const dotenv = require('dotenv');
const { z } = require('zod');

const serverRoot = path.resolve(__dirname, '..');

dotenv.config({
  path: [path.join(serverRoot, '.env.local'), path.join(serverRoot, '.env')],
  quiet: true,
});

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1).default('signjang'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  JWT_SECRET: z.string().min(32),
  SMS_CODE_PEPPER: z.string().min(32),
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(180),
  SMS_DEV_MODE: booleanFromEnv,
  SMS_SIGNUP_DUPLICATE_PHONE_ALLOWLIST: z.string().default('')
    .transform((value) => value.split(',').map((phone) => phone.trim().replace(/[-\s]/g, '')).filter(Boolean))
    .pipe(z.array(z.string().regex(/^0\d{9,10}$/))),
  SIGNUP_ACCOUNT_UPDATE_PHONE_ALLOWLIST: z.string().default('')
    .transform((value) => value.split(',').map((phone) => phone.trim().replace(/[-\s]/g, '')).filter(Boolean))
    .pipe(z.array(z.string().regex(/^0\d{9,10}$/))),
  SOLAPI_API_KEY: z.string().optional().default(''),
  SOLAPI_API_SECRET: z.string().optional().default(''),
  SOLAPI_SENDER: z.string().optional().default(''),
  ALIGO_API_KEY: z.string().optional().default(''),
  ALIGO_USER_ID: z.string().optional().default(''),
  ALIGO_SENDER: z.string().optional().default(''),
  KMA_API_KEY: z.string().trim().optional().default(''),
  KMA_API_BASE_URL: z.string().url().default('https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/'),
  WEATHER_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  WEATHER_STALE_TTL_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  WEATHER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  KAKAO_REST_API_KEY: z.string().trim().optional().default(''),
  KAKAO_LOCAL_API_BASE_URL: z.string().url().default('https://dapi.kakao.com/v2/local/search/address.json'),
  KAKAO_LOCAL_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`서버 환경변수를 확인해주세요: ${missing}`);
}

const env = parsed.data;

module.exports = {
  config: {
    corsOrigins: env.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
    db: {
      connectionLimit: env.DB_CONNECTION_LIMIT,
      connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
      database: env.DB_NAME,
      host: env.DB_HOST,
      password: env.DB_PASSWORD,
      port: env.DB_PORT,
      user: env.DB_USER,
    },
    host: env.HOST,
    jwt: {
      secret: env.JWT_SECRET,
    },
    port: env.PORT,
    signup: {
      accountUpdatePhoneAllowlist: env.SIGNUP_ACCOUNT_UPDATE_PHONE_ALLOWLIST,
    },
    sms: {
      codePepper: env.SMS_CODE_PEPPER,
      codeTtlSeconds: env.SMS_CODE_TTL_SECONDS,
      devMode: env.SMS_DEV_MODE,
      signupDuplicatePhoneAllowlist: env.SMS_SIGNUP_DUPLICATE_PHONE_ALLOWLIST,
      solapiApiKey: env.SOLAPI_API_KEY,
      solapiApiSecret: env.SOLAPI_API_SECRET,
      solapiSender: env.SOLAPI_SENDER,
      aligoApiKey: env.ALIGO_API_KEY,
      aligoSender: env.ALIGO_SENDER,
      aligoUserId: env.ALIGO_USER_ID,
    },
    siteGeocoder: {
      kakaoLocalApiBaseUrl: env.KAKAO_LOCAL_API_BASE_URL,
      kakaoLocalApiTimeoutMs: env.KAKAO_LOCAL_API_TIMEOUT_MS,
      kakaoRestApiKey: env.KAKAO_REST_API_KEY,
    },
    weather: {
      cacheTtlMs: env.WEATHER_CACHE_TTL_SECONDS * 1000,
      kmaApiKey: env.KMA_API_KEY,
      kmaBaseUrl: env.KMA_API_BASE_URL,
      requestTimeoutMs: env.WEATHER_REQUEST_TIMEOUT_MS,
      staleTtlMs: env.WEATHER_STALE_TTL_SECONDS * 1000,
    },
  },
};
