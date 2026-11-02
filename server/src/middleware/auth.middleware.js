const jwt = require('jsonwebtoken');

const { AppError } = require('../errors');

function createRequireAuth(config) {
  return (request, _response, next) => {
    const authorization = request.get('authorization') ?? '';
    const [scheme, token] = authorization.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(new AppError(401, 'AUTH_REQUIRED', '로그인이 필요합니다.'));
    }

    try {
      const payload = jwt.verify(token, config.jwt.secret, { ignoreExpiration: true });
      const userId = Number(payload.sub);
      if (typeof payload !== 'object' || payload.type !== 'access' || !Number.isSafeInteger(userId) || userId < 1) {
        throw new Error('invalid access token');
      }
      request.auth = { userId };
      return next();
    } catch {
      return next(new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요.'));
    }
  };
}

module.exports = { createRequireAuth };
