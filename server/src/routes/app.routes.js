const express = require('express');
const path = require('node:path');
const { z } = require('zod');

const { AppError, asyncHandler } = require('../errors');
const { equipmentCategorySchema } = require('../equipment');
const { createRequireAuth } = require('../middleware/auth.middleware');
const { searchPostcodes } = require('../services/postcode.service');
const {
  contractDeliveryUpload,
  documentUpload,
  profileImageUpload,
  removeUploadedFile,
  uploadDirectory,
  validateProfileImageFile,
} = require('../upload');

const parseBody = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      '입력값을 확인해 주세요.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
};

const idSchema = z.coerce.number().int().positive();
const weatherQuerySchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lon: z.coerce.number().finite().min(-180).max(180),
});
const postcodeQuerySchema = z.string().trim().min(2).max(80);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD 형식이어야 합니다.').refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return value.slice(0, 4) >= '1000' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '달력에 있는 날짜를 입력해 주세요.');
const recipientPhoneSchema = z.string().transform((value) => value.replace(/\D/g, '')).refine(
  (value) => /^(?:01[016789]\d{7,8}|02\d{7,8}|0[3-9]\d\d{7,8}|050\d\d{7,8}|1[568]\d{6})$/.test(value),
  '올바른 전화번호를 입력해 주세요.',
);
const contactPhoneSchema = z.string().transform((value) => value.replace(/\D/g, '')).refine(
  (value) => /^\d{7,15}$/.test(value),
  '연락처 전화번호를 확인해 주세요.',
);
const workStatusSchema = z.enum(['scheduled', 'inProgress', 'ended', 'unpaid', 'settled']);
const siteLatitudeSchema = z.number().finite().min(-90).max(90);
const siteLongitudeSchema = z.number().finite().min(-180).max(180);
const optionalSiteLatitudeSchema = z.union([siteLatitudeSchema, z.null()]).optional();
const optionalSiteLongitudeSchema = z.union([siteLongitudeSchema, z.null()]).optional();

const validateSiteCoordinatePair = (value, context) => {
  const latitudeProvided = value.siteLatitude !== undefined && value.siteLatitude !== null;
  const longitudeProvided = value.siteLongitude !== undefined && value.siteLongitude !== null;
  const latitudeCleared = value.siteLatitude === null;
  const longitudeCleared = value.siteLongitude === null;

  if (latitudeProvided !== longitudeProvided || latitudeCleared !== longitudeCleared) {
    context.addIssue({
      code: 'custom',
      message: '현장 위도와 경도는 함께 입력하거나 함께 비워야 합니다.',
      path: ['siteLatitude'],
    });
  }
};

const siteLocationSchema = z.object({
  siteLatitude: z.union([siteLatitudeSchema, z.null()]),
  siteLongitude: z.union([siteLongitudeSchema, z.null()]),
}).strict().superRefine(validateSiteCoordinatePair);

const profileSchema = z.object({
  birthYear: z.number().int().min(1900).max(new Date().getFullYear()).nullable(),
  businessRegistrationNo: z.string().trim().max(20).default(''),
  companyName: z.string().trim().min(1).max(100),
  email: z.union([z.string().trim().email(), z.literal('')]).default(''),
  fullName: z.string().trim().min(1).max(60),
  gender: z.enum(['male', 'female', 'other']),
  marketingAgreed: z.boolean().default(false),
});

const bankSchema = z.object({
  accountNumber: z.string().transform((value) => value.replace(/\D/g, '')).refine((value) => value.length >= 8),
  bankName: z.string().trim().min(1).max(50),
  holderName: z.string().trim().min(1).max(60),
});

const equipmentSchema = z.object({
  category: equipmentCategorySchema,
  id: z.string().optional(),
  image: z.string().trim().max(50).default('sampleMachinery'),
  tonnage: z.string().trim().max(50).default(''),
  vehicleNo: z.string().trim().max(30).default(''),
});

const contractSchema = z.object({
  businessPhotos: z.number().int().min(0).max(30).optional(),
  confirmerName: z.string().trim().max(100).optional(),
  confirmerPhone: z.string().trim().max(30).optional(),
  documentDate: dateSchema.optional(),
  endDate: dateSchema,
  equipment: z.string().trim().max(100).default(''),
  fee: z.number().int().min(0).max(1_000_000_000_000),
  id: z.string().optional(),
  memo: z.string().max(3000).default(''),
  orderer: z.string().trim().max(100).default(''),
  progress: workStatusSchema,
  sentTo: z.array(z.string().max(50)).max(20).optional(),
  signatureDataUrl: z.string().startsWith('data:image/').max(500_000).optional(),
  signatureDone: z.boolean().optional(),
  siteAddress: z.string().trim().max(300).default(''),
  siteLatitude: optionalSiteLatitudeSchema,
  siteLongitude: optionalSiteLongitudeSchema,
  siteName: z.string().trim().max(200).default(''),
  sitePhone: z.string().trim().max(30).default(''),
  startDate: dateSchema,
  status: z.enum(['draft', 'saved', 'completed']),
  tenant: z.string().trim().max(100).default(''),
  type: z.enum(['건설기계사용확인서', '건설기계사용청구서', '장비임대사용계약서', '작업확인서']),
  updatedAt: z.string().optional(),
  vehicleNo: z.string().trim().max(30).default(''),
  workPhotos: z.number().int().min(0).max(30).optional(),
  workTime: z.string().trim().max(20).default(''),
}).passthrough().superRefine(validateSiteCoordinatePair).superRefine((contract, context) => {
  if (contract.endDate < contract.startDate) {
    context.addIssue({ code: 'custom', message: '종료일은 시작일보다 빠를 수 없습니다.', path: ['endDate'] });
  }
});

const scheduleFieldsSchema = z.object({
  contractId: z.string().regex(/^\d+$/).optional(),
  date: dateSchema,
  equipment: z.string().trim().max(100).default(''),
  fee: z.number().int().min(0).max(1_000_000_000_000),
  id: z.string().optional(),
  note: z.string().max(3000).default(''),
  orderer: z.string().trim().max(100).optional(),
  orderPhone: z.string().trim().max(30).optional(),
  settlement: z.enum(['미수금', '정산완료']),
  siteAddress: z.string().trim().max(300).default(''),
  siteLatitude: optionalSiteLatitudeSchema,
  siteLongitude: optionalSiteLongitudeSchema,
  siteName: z.string().trim().max(200).default(''),
  sitePhone: z.string().trim().max(30).optional(),
  status: workStatusSchema,
  tenant: z.string().trim().max(100).optional(),
  workContent: z.string().trim().max(3000).optional(),
  usagePeriods: z.array(z.string().trim().max(30)).max(20).optional(),
  usageHours: z.string().trim().max(30).optional(),
  hourWork: z.string().trim().max(30).optional(),
  nightWork: z.string().trim().max(30).optional(),
  vehicleNo: z.string().trim().max(30).default(''),
  weather: z.string().trim().max(100).default(''),
}).passthrough();

const scheduleSchema = scheduleFieldsSchema.extend({ statusOnly: z.never().optional() })
  .superRefine(validateSiteCoordinatePair);
const scheduleUpdateSchema = scheduleFieldsSchema.extend({ statusOnly: z.boolean().optional() })
  .superRefine(validateSiteCoordinatePair);

const allianceSchema = z.object({
  contactName: z.string().trim().min(1).max(60),
  phone: contactPhoneSchema,
  tradeName: z.string().trim().max(100).default(''),
});

const contactImportSchema = z.array(z.object({
  contactName: z.string().trim().min(1).max(60),
  phone: contactPhoneSchema,
  tradeName: z.string().trim().max(100).default('개인 연락처'),
})).min(1).max(2_000);

const inquirySchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  title: z.string().trim().min(1).max(150),
});

const deliverySchema = z.object({
  recipientName: z.string().trim().max(60).optional().default(''),
  recipientPhone: recipientPhoneSchema,
  recipientType: z.string().trim().min(1).max(50),
});
const documentDeliverySchema = z.object({
  documentIds: z.array(idSchema).min(1).max(18).transform((ids) => [...new Set(ids)]),
  recipientPhone: recipientPhoneSchema,
});

const documentMetadataSchema = z.object({
  documentType: z.string().trim().min(1).max(80),
  expiresOn: z.union([dateSchema, z.literal('')]).optional().default(''),
  label: z.string().trim().min(1).max(100),
});

const profileDocumentIdFromUrl = (profileImageUrl) => {
  const match = /^\/api\/documents\/(\d+)\/file$/.exec(profileImageUrl || '');
  if (!match) return null;

  const documentId = Number(match[1]);
  return Number.isSafeInteger(documentId) && documentId > 0 ? documentId : null;
};

const profileDocumentUrl = (documentId) => `/api/documents/${documentId}/file`;

const discardStagedProfileImage = async (appService, userId, document, stagedFileUrl) => {
  let fileUrl = stagedFileUrl;

  if (document?.id) {
    try {
      const deletedDocument = await appService.deleteDocument(userId, Number(document.id));
      fileUrl = deletedDocument?.file_url || fileUrl;
    } catch (error) {
      console.warn('[profile-image] could not remove staged document record', error);
    }
  }

  await removeUploadedFile(fileUrl);
};

const removePreviousProfileImage = async (appService, userId, profileImageUrl) => {
  const documentId = profileDocumentIdFromUrl(profileImageUrl);
  if (!documentId) {
    await removeUploadedFile(profileImageUrl);
    return;
  }

  try {
    const previousDocument = await appService.deleteDocument(userId, documentId);
    await removeUploadedFile(previousDocument.file_url);
  } catch (error) {
    // The new avatar is already active. Preserve it even if old-file cleanup is delayed.
    console.warn('[profile-image] could not remove previous image', error);
  }
};

const { defaultPlans, listPlans } = require('../admin/plans');

function createAppRouter({ appService, config, pool, weatherService }) {
  const router = express.Router();
  const requireAuth = createRequireAuth(config);

  router.get('/terms/:slug', asyncHandler(async (request, response) => {
    const data = await appService.getTerms(request.params.slug);
    if (!data) throw new AppError(404, 'TERMS_NOT_FOUND', '약관을 찾을 수 없습니다.');
    response.json({ data, success: true });
  }));

  router.use(requireAuth);
  router.use(asyncHandler(async (request, _response, next) => {
    // The production AppService always implements this check. Keep route-only
    // test doubles usable while revoking all app access for inactive accounts.
    if (typeof appService.requireProfile === 'function') await appService.requireProfile(request.auth.userId);
    next();
  }));

  router.get('/app/bootstrap', asyncHandler(async (request, response) => {
    response.json({ data: await appService.bootstrap(request.auth.userId), success: true });
  }));

  router.get('/postcodes', asyncHandler(async (request, response) => {
    const query = parseBody(postcodeQuerySchema, request.query.q);
    try {
      response.json({ data: await searchPostcodes(query, {
        apiKey: config.siteGeocoder?.kakaoRestApiKey,
        baseUrl: config.siteGeocoder?.kakaoLocalApiBaseUrl,
        timeoutMs: config.siteGeocoder?.kakaoLocalApiTimeoutMs,
      }), success: true });
    } catch (error) {
      console.error('[postcode] Kakao address search failed', error);
      throw new AppError(502, 'POSTCODE_SEARCH_FAILED', '주소 검색 서비스에 연결하지 못했습니다.');
    }
  }));

  router.get('/weather', asyncHandler(async (request, response) => {
    if (!weatherService) {
      throw new AppError(503, 'WEATHER_NOT_CONFIGURED', '날씨 서비스 설정이 아직 완료되지 않았습니다.');
    }
    const coordinates = parseBody(weatherQuerySchema, request.query);
    const data = await weatherService.getWeather(coordinates);
    response.set('Cache-Control', 'private, max-age=60');
    response.json({ data, success: true });
  }));

  router.get('/me', asyncHandler(async (request, response) => {
    response.json({ data: await appService.requireProfile(request.auth.userId), success: true });
  }));
  router.patch('/me', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateProfile(request.auth.userId, parseBody(profileSchema, request.body)), success: true });
  }));
  router.put('/me/bank-account', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateBankAccount(request.auth.userId, parseBody(bankSchema, request.body)), success: true });
  }));
  router.put('/me/profile-image', profileImageUpload.single('file'), asyncHandler(async (request, response) => {
    if (!request.file) throw new AppError(400, 'FILE_REQUIRED', '업로드할 이미지를 선택해 주세요.');

    const userId = request.auth.userId;
    const stagedFileUrl = `/uploads/${request.file.filename}`;
    if (!(await validateProfileImageFile(request.file))) {
      await removeUploadedFile(stagedFileUrl);
      throw new AppError(400, 'UNSUPPORTED_PROFILE_IMAGE', '프로필 이미지는 지원되는 이미지 파일만 업로드할 수 있습니다.');
    }

    let document;
    let previousProfile;
    let updatedProfile;

    try {
      previousProfile = await appService.requireProfile(userId);
      document = await appService.createDocument(userId, {
        documentType: 'profile',
        fileUrl: stagedFileUrl,
        label: '프로필 이미지',
        mimeType: request.file.mimetype,
        originalName: request.file.originalname,
      });
      updatedProfile = await appService.updateProfileImage(userId, document.fileUrl);
    } catch (error) {
      let isActiveProfileImage = false;

      if (document) {
        try {
          const currentProfile = await appService.requireProfile(userId);
          isActiveProfileImage = currentProfile.profileImageUrl === document.fileUrl;
        } catch (profileError) {
          // Do not risk deleting an image that may already have become active.
          console.warn('[profile-image] could not verify staged image state', profileError);
          isActiveProfileImage = true;
        }
      }

      if (!isActiveProfileImage) {
        await discardStagedProfileImage(appService, userId, document, stagedFileUrl);
      }

      throw error;
    }

    await removePreviousProfileImage(appService, userId, previousProfile.profileImageUrl);
    response.status(201).json({
      data: updatedProfile,
      success: true,
    });
  }));
  router.delete('/me', asyncHandler(async (request, response) => {
    response.json({ data: await appService.deleteAccount(request.auth.userId), success: true });
  }));

  router.get('/equipments', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listEquipments(request.auth.userId), success: true });
  }));
  router.put('/equipments', asyncHandler(async (request, response) => {
    const equipments = parseBody(z.array(equipmentSchema).max(50), request.body);
    response.json({ data: await appService.replaceEquipments(request.auth.userId, equipments), success: true });
  }));

  router.get('/contracts', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listContracts(request.auth.userId), success: true });
  }));
  router.post('/contracts', asyncHandler(async (request, response) => {
    response.status(201).json({ data: await appService.createContract(request.auth.userId, parseBody(contractSchema, request.body)), success: true });
  }));
  router.put('/contracts/:id', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateContract(request.auth.userId, parseBody(idSchema, request.params.id), parseBody(contractSchema, request.body)), success: true });
  }));
  router.post('/contracts/:id/site-location', asyncHandler(async (request, response) => {
    response.json({ data: await appService.resolveContractSiteLocation(
      request.auth.userId,
      parseBody(idSchema, request.params.id),
    ), success: true });
  }));
  router.put('/contracts/:id/site-location', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateContractSiteLocation(
      request.auth.userId,
      parseBody(idSchema, request.params.id),
      parseBody(siteLocationSchema, request.body),
    ), success: true });
  }));
  router.delete('/contracts/:id', asyncHandler(async (request, response) => {
    response.json({ data: await appService.deleteContract(request.auth.userId, parseBody(idSchema, request.params.id)), success: true });
  }));
  router.post('/contracts/:id/deliveries', contractDeliveryUpload.single('contractImage'), asyncHandler(async (request, response) => {
    const delivery = parseBody(deliverySchema, request.body);
    response.status(202).json({ data: await appService.createContractDelivery(
      request.auth.userId,
      parseBody(idSchema, request.params.id),
      { ...delivery, image: request.file },
    ), success: true });
  }));

  router.get('/schedules', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listSchedules(request.auth.userId), success: true });
  }));
  router.post('/schedules', asyncHandler(async (request, response) => {
    response.status(201).json({ data: await appService.createSchedule(request.auth.userId, parseBody(scheduleSchema, request.body)), success: true });
  }));
  router.put('/schedules/:id', asyncHandler(async (request, response) => {
    const { statusOnly = false, ...schedule } = parseBody(scheduleUpdateSchema, request.body);
    response.json({ data: await appService.updateSchedule(request.auth.userId, parseBody(idSchema, request.params.id), schedule, { statusOnly }), success: true });
  }));
  router.post('/schedules/:id/site-location', asyncHandler(async (request, response) => {
    response.json({ data: await appService.resolveScheduleSiteLocation(
      request.auth.userId,
      parseBody(idSchema, request.params.id),
    ), success: true });
  }));
  router.put('/schedules/:id/site-location', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateScheduleSiteLocation(
      request.auth.userId,
      parseBody(idSchema, request.params.id),
      parseBody(siteLocationSchema, request.body),
    ), success: true });
  }));
  router.delete('/schedules/:id', asyncHandler(async (request, response) => {
    response.json({ data: await appService.deleteSchedule(request.auth.userId, parseBody(idSchema, request.params.id)), success: true });
  }));

  router.get('/alliances', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listAlliances(request.auth.userId), success: true });
  }));
  router.post('/alliances', asyncHandler(async (request, response) => {
    response.status(201).json({ data: await appService.createAlliance(request.auth.userId, parseBody(allianceSchema, request.body)), success: true });
  }));
  router.put('/alliances/by-phone', asyncHandler(async (request, response) => {
    response.json({ data: await appService.updateAllianceByPhone(request.auth.userId, parseBody(allianceSchema, request.body)), success: true });
  }));
  router.post('/contacts/import', asyncHandler(async (request, response) => {
    const contacts = parseBody(contactImportSchema, request.body);
    response.json({ data: await appService.importContacts(request.auth.userId, contacts), success: true });
  }));

  router.get('/documents', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listDocuments(request.auth.userId), success: true });
  }));
  router.post('/documents/deliveries', asyncHandler(async (request, response) => {
    const delivery = parseBody(documentDeliverySchema, request.body);
    response.json({ data: await appService.sendDocuments(request.auth.userId, delivery), success: true });
  }));
  router.get('/documents/:id/file', asyncHandler(async (request, response) => {
    const document = await appService.getDocumentFile(request.auth.userId, parseBody(idSchema, request.params.id));
    const filename = path.basename(document.file_url);
    response.type(document.mime_type || 'application/octet-stream');
    response.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.original_name || filename)}`);
    response.sendFile(filename, { root: uploadDirectory });
  }));
  router.post('/documents', documentUpload.single('file'), asyncHandler(async (request, response) => {
    if (!request.file) throw new AppError(400, 'FILE_REQUIRED', '업로드할 파일을 선택해 주세요.');
    const metadata = parseBody(documentMetadataSchema, request.body);
    const data = await appService.createDocument(request.auth.userId, {
      ...metadata,
      fileUrl: `/uploads/${request.file.filename}`,
      mimeType: request.file.mimetype,
      originalName: request.file.originalname,
    });
    response.status(201).json({ data, success: true });
  }));
  router.delete('/documents/:id', asyncHandler(async (request, response) => {
    const userId = request.auth.userId;
    const documentId = parseBody(idSchema, request.params.id);
    await appService.getDocumentFile(userId, documentId);

    const profile = await appService.requireProfile(userId);
    if (profile.profileImageUrl === profileDocumentUrl(documentId)) {
      throw new AppError(409, 'PROFILE_IMAGE_IN_USE', '현재 프로필 이미지로 사용 중인 파일은 삭제할 수 없습니다.');
    }

    const document = await appService.deleteDocument(userId, documentId);
    await removeUploadedFile(document.file_url);
    response.json({ data: { message: '서류가 삭제되었습니다.' }, success: true });
  }));

  router.get('/inquiries', asyncHandler(async (request, response) => {
    response.json({ data: await appService.listInquiries(request.auth.userId), success: true });
  }));
  router.get('/inquiries/:id', asyncHandler(async (request, response) => {
    response.json({ data: await appService.getInquiry(request.auth.userId, parseBody(idSchema, request.params.id)), success: true });
  }));
  router.post('/inquiries', asyncHandler(async (request, response) => {
    response.status(201).json({ data: await appService.createInquiry(request.auth.userId, parseBody(inquirySchema, request.body)), success: true });
  }));

  router.get('/notices', asyncHandler(async (_request, response) => {
    response.json({ data: await appService.listNotices(), success: true });
  }));
  router.get('/notices/:id', asyncHandler(async (request, response) => {
    response.json({ data: await appService.getNotice(parseBody(idSchema, request.params.id)), success: true });
  }));
  router.get('/plans', asyncHandler(async (_request, response) => response.json({ data: pool ? await listPlans(pool) : defaultPlans, success: true })));

  return router;
}

module.exports = { createAppRouter };
