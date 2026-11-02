const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { AppError, asyncHandler } = require('../errors');
const { koreanToday } = require('../workflow');
const { uploadDirectory } = require('../upload');
const { createAdminAuth } = require('./auth');
const { AdminRepository } = require('./repository');

const text = (length) => z.string().trim().min(1).max(length);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
});
const phone = z.string().transform((value) => value.replace(/[-\s]/g, '')).pipe(z.string().regex(/^0\d{9,10}$/));
const statuses = ['scheduled', 'inProgress', 'ended', 'unpaid', 'settled'];
const partial = (shape) => z.object(shape).partial().strict().refine((value) => Object.keys(value).length > 0, '변경할 값을 입력해 주세요.');
const noticeShape = { slug: text(120).regex(/^[a-zA-Z0-9_-]+$/), title: text(200), body: text(50000), publishedAt: z.iso.datetime({ offset: true }) };
const patches = {
  users: partial({ fullName: text(60), companyName: text(100), email: z.union([z.email().max(190), z.literal('')]), phone, status: z.enum(['active', 'inactive']) }),
  contracts: partial({ status: z.enum(['draft', 'saved', 'completed']), type: text(50), startDate: date, fee: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), siteName: z.string().trim().max(200), siteAddress: z.string().trim().max(500), orderer: z.string().trim().max(100), orderPhone: z.string().trim().max(30), workContent: z.string().trim().max(10000), memo: z.string().trim().max(10000) }),
  schedules: z.object({ status: z.enum(statuses) }).strict(),
  equipments: partial({ category: text(50), tonnage: z.string().trim().max(50), vehicleNo: z.string().trim().max(30) }),
  documents: partial({ label: z.string().trim().max(100), documentType: text(80), expiresOn: z.union([date, z.literal(''), z.null()]) }),
  inquiries: z.object({ answer: z.string().trim().max(30000) }).strict(),
  notices: partial(noticeShape),
  terms: partial({ title: text(150), body: text(50000), version: text(30), effectiveOn: date }),
  plans: partial({ name: text(100), price: z.number().int().nonnegative().max(1000000000), currency: z.literal('KRW'), billingPeriod: z.enum(['monthly', 'yearly']), features: z.array(text(200)).max(30), active: z.boolean() }),
  alliances: partial({ tradeName: text(100), contactName: text(60), phone }),
};
const resourceStatuses = {
  users: ['active', 'inactive', 'withdrawn'], contracts: ['draft', 'saved', 'completed'], schedules: statuses,
  inquiries: ['pending', 'answered'], deliveries: ['queued', 'sent', 'failed'], plans: ['active', 'inactive'],
};
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(150).optional(), status: z.string().max(30).optional(),
  progress: z.enum(statuses).optional(),
  from: date.optional(), to: date.optional(),
}).strict();

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', '입력 값을 확인해 주세요.', result.error.flatten());
  return result.data;
}

function validatePeriod(query, bounded = false) {
  if (query.from && query.to) {
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86400000;
    if (days < 0 || (bounded && days > 365)) throw new AppError(400, 'INVALID_DATE_RANGE', '조회 기간은 시작일부터 최대 1년까지 선택해 주세요.');
  }
  return query;
}

function idFor(resource, raw) {
  return parse(['terms', 'plans'].includes(resource) ? text(120).regex(/^[a-zA-Z0-9_-]+$/) : z.string().regex(/^[1-9]\d{0,14}$/), raw);
}

function createAdminRouter({ config, pool, appService, repository = new AdminRepository(pool, appService) }) {
  const router = express.Router();
  const auth = createAdminAuth(config);
  const send = (response, data, status = 200) => response.status(status).json({ success: true, data });
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, error: { code: 'ADMIN_LOGIN_RATE_LIMIT', message: '잠시 후 다시 로그인해 주세요.' } } }), asyncHandler(async (request, response) => {
    send(response, await auth.login(parse(z.object({
      username: text(100).optional(),
      password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value, 'utf8') <= 72, '비밀번호는 UTF-8 기준 72바이트 이하여야 합니다.'),
    }).strict(), request.body)));
  }));
  router.use(auth.requireAdmin);
  router.get('/auth/session', (request, response) => send(response, { admin: request.admin }));
  router.get('/dashboard', asyncHandler(async (request, response) => {
    const today = koreanToday();
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    const input = parse(z.object({ from: date.optional(), to: date.optional() }).strict(), request.query);
    const period = validatePeriod({ from: input.from ?? start.toISOString().slice(0, 10), to: input.to ?? today }, true);
    send(response, await repository.dashboard(period));
  }));
  router.get('/documents/:id/file', asyncHandler(async (request, response) => {
    const file = await repository.documentFile(idFor('documents', request.params.id));
    if (!file.file_url?.startsWith('/uploads/')) throw new AppError(404, 'FILE_NOT_FOUND', '파일을 찾을 수 없습니다.');
    const filename = path.basename(file.file_url);
    response.type(file.mime_type || 'application/octet-stream');
    response.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name || filename)}`);
    response.sendFile(filename, { root: uploadDirectory }, (error) => {
      if (error && !response.headersSent) response.status(404).json({ success: false, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
    });
  }));
  router.get('/:resource', asyncHandler(async (request, response) => {
    const { resource } = request.params;
    const query = validatePeriod(parse(querySchema, request.query));
    if (query.status && (!Object.hasOwn(resourceStatuses, resource) || !resourceStatuses[resource].includes(query.status))) throw new AppError(400, 'INVALID_FILTER', '상태 필터를 확인해 주세요.');
    if (query.progress && resource !== 'contracts') throw new AppError(400, 'INVALID_FILTER', '작업 상태 필터는 계약서에서만 사용할 수 있습니다.');
    send(response, await repository.list(resource, query));
  }));
  router.get('/:resource/:id', asyncHandler(async (request, response) => send(response, await repository.get(request.params.resource, idFor(request.params.resource, request.params.id)))));
  router.patch('/:resource/:id', asyncHandler(async (request, response) => {
    const { resource } = request.params;
    if (!Object.hasOwn(patches, resource)) throw new AppError(405, 'ADMIN_READ_ONLY', '조회 전용 항목입니다.');
    try {
      send(response, await repository.patch(resource, idFor(resource, request.params.id), parse(patches[resource], request.body)));
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new AppError(409, 'DUPLICATE_VALUE', '이미 사용 중인 값입니다.');
      if (error.code === 'ER_NO_SUCH_TABLE' && resource === 'plans') throw new AppError(503, 'ADMIN_MIGRATION_REQUIRED', '서버 DB 마이그레이션을 먼저 실행해 주세요.');
      throw error;
    }
  }));
  router.post('/notices', asyncHandler(async (request, response) => {
    try { send(response, await repository.createNotice(parse(z.object(noticeShape).strict(), request.body)), 201); }
    catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new AppError(409, 'DUPLICATE_VALUE', '이미 사용 중인 공지 주소입니다.');
      throw error;
    }
  }));
  router.delete('/:resource/:id', asyncHandler(async (request, response) => send(response, await repository.remove(request.params.resource, idFor(request.params.resource, request.params.id)))));
  router.use((_request, _response, next) => next(new AppError(404, 'ADMIN_NOT_FOUND', '관리자 API를 찾을 수 없습니다.')));
  return router;
}

module.exports = { createAdminRouter, parse, querySchema, patches };
