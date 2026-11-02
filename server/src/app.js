const cors = require('cors');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('node:fs');
const path = require('node:path');

const { AppError, asyncHandler } = require('./errors');
const { createAppRouter } = require('./routes/app.routes');
const { createAuthRouter } = require('./routes/auth.routes');
const { createAdminRouter } = require('./admin/routes');

const databaseNetworkErrors = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
]);

function createApp({ appService, authService, config, corsOrigins, pool, weatherService }) {
  const app = express();
  const allowedOrigins = new Set(corsOrigins);

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors((request, callback) => {
    const origin = request.get('origin');
    let sameOrigin = false;
    try {
      const parsed = new URL(origin);
      sameOrigin = ['http:', 'https:'].includes(parsed.protocol)
        && parsed.origin === origin
        && parsed.host.toLowerCase() === (request.get('host') || '').toLowerCase();
    } catch { /* Native requests do not carry a browser Origin header. */ }
    if (!origin || allowedOrigins.has(origin) || sameOrigin) return callback(null, { credentials: false, origin: true });
    return callback(new AppError(403, 'CORS_NOT_ALLOWED', '허용되지 않은 요청 출처입니다.'));
  }));
  // Admin terms/notices allow up to 50,000 characters, including Korean text.
  app.use('/api/admin', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({
    legacyHeaders: false,
    limit: 300,
    standardHeaders: 'draft-8',
    windowMs: 15 * 60 * 1000,
  }));

  app.get('/api/health', asyncHandler(async (_request, response) => {
    await pool.execute('SELECT 1');
    response.json({ data: { database: 'connected', status: 'ok' }, success: true });
  }));

  app.use('/api/auth', createAuthRouter({ authService }));
  app.use('/api/admin', createAdminRouter({ appService, config, pool }));
  app.use('/api', createAppRouter({ appService, config, pool, weatherService }));

  const adminDirectory = path.resolve(__dirname, '../../admin/dist');
  app.use('/admin', helmet.contentSecurityPolicy({ directives: { frameSrc: ["'self'", 'blob:'] } }));
  app.use('/admin', express.static(adminDirectory, { index: false, dotfiles: 'deny' }));
  app.get(/^\/admin(?:\/.*)?$/, (request, response, next) => {
    const indexFile = path.join(adminDirectory, 'index.html');
    if (path.extname(request.path) || !fs.existsSync(indexFile)) {
      return next(new AppError(404, 'ADMIN_BUILD_NOT_FOUND', '관리자 화면 빌드를 확인해 주세요.'));
    }
    response.set('Cache-Control', 'no-cache');
    return response.sendFile(indexFile);
  });

  app.use((_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.'));
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.too.large') {
      return response.status(413).json({ success: false, error: { code: 'REQUEST_TOO_LARGE', message: '요청 데이터가 너무 큽니다.' } });
    }
    if (
      error?.name === 'MulterError' ||
      error?.message === 'UNSUPPORTED_FILE_TYPE' ||
      error?.message === 'UNSUPPORTED_CONTRACT_IMAGE'
    ) {
      return response.status(400).json({
        error: {
          code: error?.message === 'UNSUPPORTED_CONTRACT_IMAGE'
            ? 'UNSUPPORTED_CONTRACT_IMAGE'
            : error?.message === 'UNSUPPORTED_FILE_TYPE'
              ? 'UNSUPPORTED_FILE_TYPE'
              : 'UPLOAD_FAILED',
          message: error?.code === 'LIMIT_FILE_SIZE'
            ? error?.field === 'contractImage'
              ? '계약서 이미지는 4MB 이하로 보내 주세요.'
              : '파일은 10MB 이하만 업로드할 수 있습니다.'
            : error?.message === 'UNSUPPORTED_CONTRACT_IMAGE'
              ? '계약서 이미지는 JPG 또는 PNG 형식이어야 합니다.'
              : '이미지 또는 PDF 파일을 확인해 주세요.',
        },
        success: false,
      });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return response.status(400).json({
        error: { code: 'INVALID_JSON', message: '올바른 JSON 요청이 아닙니다.' },
        success: false,
      });
    }

    if (error instanceof AppError) {
      return response.status(error.status).json({
        error: { code: error.code, details: error.details, message: error.message },
        success: false,
      });
    }

    if (databaseNetworkErrors.has(error?.code)) {
      console.error(`[database] connection failed: ${error.code}`);
      return response.status(503).json({
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: '데이터베이스 서버의 3306 포트에 연결할 수 없습니다. 서버 네트워크 설정을 확인해 주세요.',
        },
        success: false,
      });
    }

    console.error(error);
    return response.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '서버 오류가 발생했습니다.' },
      success: false,
    });
  });

  return app;
}

module.exports = { createApp };
