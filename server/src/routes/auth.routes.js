const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');

const { isValidPassword, isValidPhone, normalizePhone } = require('../auth-utils');
const { AppError, asyncHandler } = require('../errors');
const { equipmentCategorySchema } = require('../equipment');

const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .refine(isValidPhone, '올바른 전화번호를 입력해주세요.');

const passwordSchema = z
  .string()
  .refine(isValidPassword, '비밀번호는 영문, 숫자, 특수문자 중 2가지 이상을 포함한 8~16자여야 합니다.');

const parseBody = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '입력값을 확인해주세요.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
};

const loginSchema = z.object({ phone: phoneSchema, password: z.string().min(1) });

const smsSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(['signup', 'password_reset']),
});

const verifySmsSchema = smsSchema.extend({ code: z.string().regex(/^\d{6}$/, '인증번호 6자리를 입력해주세요.') });

const signupEquipmentSchema = z.union([
  equipmentCategorySchema,
  z.object({
    category: equipmentCategorySchema,
    tonnage: z.string().trim().min(1, '장비 규격을 선택해주세요.').max(50, '장비 규격은 50자 이내로 입력해주세요.'),
  }),
]);

const signupSchema = z.object({
  birthYear: z.number().int().min(1900).max(new Date().getFullYear()).nullable().optional(),
  companyName: z.string().trim().min(1, '상호를 입력해주세요.').max(100, '상호는 100자 이내로 입력해주세요.'),
  email: z.union([
    z.string().trim().email('올바른 이메일 주소를 입력해주세요.').max(190, '이메일은 190자 이내로 입력해주세요.'),
    z.literal(''),
  ]).optional().default(''),
  equipments: z.array(signupEquipmentSchema).max(20).default([]),
  fullName: z.string().trim().min(1).max(60),
  gender: z.enum(['male', 'female', 'other']).default('other'),
  marketingAgreed: z.boolean().default(false),
  password: passwordSchema,
  phone: phoneSchema,
  referralCode: z.string().trim().max(20).optional(),
  smsVerificationToken: z.string().min(1),
});

const signupBusinessSchema = signupSchema.pick({
  companyName: true,
  email: true,
  phone: true,
  smsVerificationToken: true,
});

const findPhoneSchema = z.object({
  companyName: z.string().trim().min(1).max(100),
  fullName: z.string().trim().min(1).max(60),
});

const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
  phone: phoneSchema,
  smsVerificationToken: z.string().min(1),
});

const smsLimiter = rateLimit({
  legacyHeaders: false,
  limit: 10,
  message: {
    error: { code: 'SMS_RATE_LIMITED', message: '인증번호 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
    success: false,
  },
  standardHeaders: 'draft-8',
  windowMs: 10 * 60 * 1000,
});

function createAuthRouter({ authService }) {
  const router = express.Router();

  router.post('/login', asyncHandler(async (request, response) => {
    const data = await authService.login(parseBody(loginSchema, request.body));
    response.json({ data, success: true });
  }));

  router.post('/sms/send', smsLimiter, asyncHandler(async (request, response) => {
    const data = await authService.sendSmsCode(parseBody(smsSchema, request.body));
    response.status(201).json({ data, success: true });
  }));

  router.post('/sms/verify', asyncHandler(async (request, response) => {
    const data = await authService.verifySmsCode(parseBody(verifySmsSchema, request.body));
    response.json({ data, success: true });
  }));

  router.post('/signup', asyncHandler(async (request, response) => {
    const data = await authService.signup(parseBody(signupSchema, request.body));
    response.status(201).json({ data, success: true });
  }));

  router.post('/signup/check-business', asyncHandler(async (request, response) => {
    const data = await authService.checkSignupBusiness(parseBody(signupBusinessSchema, request.body));
    response.json({ data, success: true });
  }));

  router.post('/find-phone', asyncHandler(async (request, response) => {
    const data = await authService.findPhone(parseBody(findPhoneSchema, request.body));
    response.json({ data, success: true });
  }));

  router.post('/password/reset', asyncHandler(async (request, response) => {
    const data = await authService.resetPassword(parseBody(resetPasswordSchema, request.body));
    response.json({ data, success: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
