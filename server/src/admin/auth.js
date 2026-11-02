const { timingSafeEqual } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AppError } = require('../errors');
const defaults = require('./defaults');

const audience = 'signjang-admin';
const issuer = 'signjang-api';

function adminSettings(config) {
  return {
    username: config.admin?.username || process.env.ADMIN_USERNAME || 'admin',
    passwordHash: config.admin?.passwordHash || process.env.ADMIN_PASSWORD_HASH || defaults.passwordHash,
    name: config.admin?.name ?? process.env.ADMIN_NAME ?? '관리자',
  };
}

function safeEqual(left, right) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function createAdminAuth(config) {
  const settings = adminSettings(config);
  const configured = Boolean(settings.username && /^\$2[aby]\$\d\d\$/.test(settings.passwordHash));
  const admin = { username: settings.username, name: settings.name };
  const requireConfigured = () => {
    if (!configured) throw new AppError(503, 'ADMIN_NOT_CONFIGURED', '서버에 관리자 계정을 설정해 주세요.');
  };
  return {
    async login({ username, password }) {
      requireConfigured();
      const passwordMatches = await bcrypt.compare(password, settings.passwordHash);
      if ((username !== undefined && !safeEqual(username, settings.username)) || !passwordMatches) {
        throw new AppError(401, 'ADMIN_LOGIN_FAILED', '비밀번호를 확인해 주세요.');
      }
      return {
        accessToken: jwt.sign({ type: 'admin' }, config.jwt.secret, {
          algorithm: 'HS256', audience, issuer, subject: settings.username, expiresIn: '8h',
        }),
        admin,
      };
    },
    requireAdmin(request, response, next) {
      response.set('Cache-Control', 'no-store');
      try {
        requireConfigured();
        const [scheme, token] = (request.get('authorization') ?? '').split(' ');
        if (scheme !== 'Bearer' || !token) throw new Error('missing token');
        const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], audience, issuer });
        if (typeof payload !== 'object' || payload.type !== 'admin' || payload.sub !== settings.username || !payload.exp) {
          throw new Error('invalid token');
        }
        request.admin = admin;
        next();
      } catch (error) {
        next(error instanceof AppError ? error : new AppError(401, 'ADMIN_AUTH_REQUIRED', '관리자 로그인이 필요합니다.'));
      }
    },
  };
}

module.exports = { createAdminAuth };
