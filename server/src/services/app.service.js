const { AppError } = require('../errors');
const fs = require('node:fs/promises');
const path = require('node:path');
const { uploadDirectory } = require('../upload');
const {
  clearsSiteCoordinates,
  coordinatesForUpdate,
  hasSiteCoordinateInput,
  normalizeSiteAddress,
  normalizeSiteCoordinates,
  withSiteCoordinates,
} = require('../site-location');

class AppService {
  constructor(repository, smsService, siteGeocoder) {
    this.repository = repository;
    this.smsService = smsService;
    this.siteGeocoder = siteGeocoder;
  }

  async requireProfile(userId) {
    const profile = await this.repository.getProfile(userId);
    if (!profile) throw new AppError(401, 'ACCOUNT_NOT_ACTIVE', '사용할 수 없는 계정입니다.');
    return profile;
  }

  async bootstrap(userId) {
    const [user, equipments, contracts, schedules] = await Promise.all([
      this.requireProfile(userId),
      this.repository.listEquipments(userId),
      this.repository.listContracts(userId),
      this.repository.listSchedules(userId),
    ]);
    return { contracts, equipments, schedules, user };
  }

  async updateProfile(userId, profile) {
    if (!(await this.repository.updateProfile(userId, profile))) {
      throw new AppError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');
    }
    return this.requireProfile(userId);
  }

  async updateBankAccount(userId, bank) {
    if (!(await this.repository.updateBankAccount(userId, bank))) {
      throw new AppError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');
    }
    return this.requireProfile(userId);
  }

  async updateProfileImage(userId, profileImageUrl) {
    if (!(await this.repository.updateProfileImage(userId, profileImageUrl))) {
      throw new AppError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');
    }
    return this.requireProfile(userId);
  }

  async deleteAccount(userId) {
    if (!(await this.repository.deleteAccount(userId))) {
      throw new AppError(404, 'USER_NOT_FOUND', '회원 정보를 찾을 수 없습니다.');
    }
    return { message: '회원 탈퇴가 완료되었습니다.' };
  }

  listEquipments(userId) { return this.repository.listEquipments(userId); }
  replaceEquipments(userId, equipments) { return this.repository.replaceEquipments(userId, equipments); }
  listContracts(userId) { return this.repository.listContracts(userId); }
  createContract(userId, contract) { return this.repository.createContract(userId, contract); }
  listSchedules(userId) { return this.repository.listSchedules(userId); }
  async createSchedule(userId, schedule) {
    let coordinates = normalizeSiteCoordinates(schedule);
    if (!coordinates && !hasSiteCoordinateInput(schedule) && schedule.contractId) {
      const contract = await this.repository.getContract(userId, schedule.contractId);
      if (sameSiteAddress(schedule, contract)) coordinates = normalizeSiteCoordinates(contract);
    }
    return this.repository.createSchedule(userId, withSiteCoordinates(schedule, coordinates));
  }
  listAlliances(userId) { return this.repository.listAlliances(userId); }
  createAlliance(userId, alliance) { return this.repository.createAlliance(userId, alliance); }
  async updateAllianceByPhone(userId, alliance) {
    const updated = await this.repository.updateAllianceByPhone(userId, alliance);
    if (!updated) throw new AppError(404, 'CONTACT_NOT_FOUND', '수정할 연락처가 없습니다. 다시 등록해 주세요.');
    return updated;
  }
  importContacts(userId, contacts) { return this.repository.importContacts(userId, contacts); }
  listDocuments(userId) { return this.repository.listDocuments(userId); }
  createDocument(userId, document) { return this.repository.createDocument(userId, document); }
  async sendDocuments(userId, { documentIds, recipientPhone }) {
    // Validate ownership and every file before sending any part of the selection.
    const documents = [];
    for (const id of documentIds) {
      const document = await this.getDocumentFile(userId, id);
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(document.mime_type)) {
        throw new AppError(400, 'DOCUMENT_MMS_FORMAT', '문자 첨부는 JPG, PNG, GIF 이미지 서류만 가능합니다.');
      }
      const filename = path.join(uploadDirectory, path.basename(document.file_url));
      let stat;
      try { stat = await fs.stat(filename); } catch {
        throw new AppError(404, 'DOCUMENT_FILE_NOT_FOUND', '서류 파일을 찾을 수 없습니다. 다시 등록해 주세요.');
      }
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
        throw new AppError(400, 'DOCUMENT_MMS_SIZE', '서류 이미지는 파일당 10MB 이하로 등록해 주세요.');
      }
      documents.push({ ...document, filename });
    }
    const sentDocumentIds = [];
    for (let index = 0; index < documents.length; index += 3) {
      const batch = documents.slice(index, index + 3);
      try {
        const images = await Promise.all(batch.map(async (document) => ({
          buffer: await fs.readFile(document.filename),
          mimetype: document.mime_type,
          originalname: document.original_name,
        })));
        await this.smsService.sendDocumentMms({ images, recipientPhone });
        sentDocumentIds.push(...batch.map((document) => String(document.id)));
      } catch (error) {
        return {
          sentDocumentIds,
          remainingDocumentIds: documents.slice(index).map((document) => String(document.id)),
          error: error instanceof AppError ? error.message : '서류 문자 발송 중 오류가 발생했습니다.',
        };
      }
    }
    return { sentDocumentIds, remainingDocumentIds: [] };
  }
  listInquiries(userId) { return this.repository.listInquiries(userId); }
  createInquiry(userId, inquiry) { return this.repository.createInquiry(userId, inquiry); }
  listNotices() { return this.repository.listNotices(); }
  getTerms(slug) { return this.repository.getTerms(slug); }

  async updateContract(userId, contractId, contract) {
    const existing = await this.repository.getContract(userId, contractId);
    if (!existing) throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');

    const coordinates = coordinatesForUpdate({ existing, incoming: contract });
    const updated = await this.repository.updateContract(
      userId,
      contractId,
      withSiteCoordinates(contract, coordinates),
    );
    if (!updated) throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');
    return updated;
  }

  async resolveContractSiteLocation(userId, contractId) {
    return this.resolveSiteLocation({
      getEntity: () => this.repository.getContract(userId, contractId),
      notFoundCode: 'CONTRACT_NOT_FOUND',
      notFoundMessage: '계약서를 찾을 수 없습니다.',
      updateCoordinates: (coordinates, expectedSiteAddress) => this.repository.updateContractSiteCoordinates(
        userId,
        contractId,
        coordinates,
        { expectedSiteAddress },
      ),
    });
  }

  async updateContractSiteLocation(userId, contractId, location) {
    return this.updateSiteLocation({
      coordinates: location,
      notFoundCode: 'CONTRACT_NOT_FOUND',
      notFoundMessage: '계약서를 찾을 수 없습니다.',
      updateCoordinates: (nextCoordinates) => this.repository.updateContractSiteCoordinates(
        userId,
        contractId,
        nextCoordinates,
      ),
    });
  }

  async deleteContract(userId, contractId) {
    if (!(await this.repository.deleteContract(userId, contractId))) {
      throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');
    }
    return { message: '계약서가 삭제되었습니다.' };
  }

  async createContractDelivery(userId, contractId, delivery) {
    const contract = await this.repository.getContract(userId, contractId);
    if (!contract) {
      throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');
    }
    if (!contract.signatureDone || typeof contract.signatureDataUrl !== 'string' || !contract.signatureDataUrl.trim()) {
      throw new AppError(400, 'CONTRACT_SIGNATURE_REQUIRED', '작업확인자 서명을 직접 작성한 뒤 문자로 보내 주세요.');
    }
    if (!delivery.image) {
      throw new AppError(400, 'CONTRACT_IMAGE_REQUIRED', '문자로 보낼 계약서 이미지를 준비하지 못했습니다.');
    }

    const sent = await this.smsService.sendContractMms({
      contract,
      image: delivery.image,
      recipientName: delivery.recipientName,
      recipientPhone: delivery.recipientPhone,
    });
    return this.repository.createContractDelivery(userId, contractId, {
      ...delivery,
      providerMessageId: sent.providerMessageId,
      status: 'sent',
    });
  }

  async updateSchedule(userId, scheduleId, schedule, { statusOnly = false } = {}) {
    const existing = await this.repository.getSchedule(userId, scheduleId);
    if (!existing) throw new AppError(404, 'SCHEDULE_NOT_FOUND', '일정을 찾을 수 없습니다.');

    let coordinates = coordinatesForUpdate({ existing, incoming: schedule });
    const linkedContractChanged = schedule.contractId && String(schedule.contractId) !== String(existing.contractId ?? '');
    if (!hasSiteCoordinateInput(schedule) && linkedContractChanged) {
      const contract = await this.repository.getContract(userId, schedule.contractId);
      coordinates = sameSiteAddress(schedule, contract) ? normalizeSiteCoordinates(contract) : null;
    }

    const updated = await this.repository.updateSchedule(
      userId,
      scheduleId,
      withSiteCoordinates(schedule, coordinates),
      { statusOnly },
    );
    if (!updated) throw new AppError(404, 'SCHEDULE_NOT_FOUND', '일정을 찾을 수 없습니다.');
    return updated;
  }

  async resolveScheduleSiteLocation(userId, scheduleId) {
    return this.resolveSiteLocation({
      getEntity: () => this.repository.getSchedule(userId, scheduleId),
      notFoundCode: 'SCHEDULE_NOT_FOUND',
      notFoundMessage: '일정을 찾을 수 없습니다.',
      updateCoordinates: (coordinates, expectedSiteAddress) => this.repository.updateScheduleSiteCoordinates(
        userId,
        scheduleId,
        coordinates,
        { expectedSiteAddress },
      ),
    });
  }

  async updateScheduleSiteLocation(userId, scheduleId, location) {
    return this.updateSiteLocation({
      coordinates: location,
      notFoundCode: 'SCHEDULE_NOT_FOUND',
      notFoundMessage: '일정을 찾을 수 없습니다.',
      updateCoordinates: (nextCoordinates) => this.repository.updateScheduleSiteCoordinates(
        userId,
        scheduleId,
        nextCoordinates,
      ),
    });
  }

  async deleteSchedule(userId, scheduleId) {
    if (!(await this.repository.deleteSchedule(userId, scheduleId))) {
      throw new AppError(404, 'SCHEDULE_NOT_FOUND', '일정을 찾을 수 없습니다.');
    }
    return { message: '일정이 삭제되었습니다.' };
  }

  async getInquiry(userId, inquiryId) {
    const inquiry = await this.repository.getInquiry(userId, inquiryId);
    if (!inquiry) throw new AppError(404, 'INQUIRY_NOT_FOUND', '문의를 찾을 수 없습니다.');
    return inquiry;
  }

  async getDocumentFile(userId, documentId) {
    const document = await this.repository.getDocumentFile(userId, documentId);
    if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '서류 파일을 찾을 수 없습니다.');
    return document;
  }

  async deleteDocument(userId, documentId) {
    const document = await this.repository.getDocumentFile(userId, documentId);
    if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '서류 파일을 찾을 수 없습니다.');
    if (!(await this.repository.deleteDocument(userId, documentId))) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', '서류 파일을 찾을 수 없습니다.');
    }
    return document;
  }

  async getNotice(noticeId) {
    const notice = await this.repository.getNotice(noticeId);
    if (!notice) throw new AppError(404, 'NOTICE_NOT_FOUND', '공지사항을 찾을 수 없습니다.');
    return notice;
  }

  async resolveSiteLocation({ getEntity, notFoundCode, notFoundMessage, updateCoordinates }) {
    const entity = await getEntity();
    if (!entity) throw new AppError(404, notFoundCode, notFoundMessage);

    const stored = normalizeSiteCoordinates(entity);
    if (stored) return { ...stored, source: 'stored' };
    if (!String(entity.siteAddress || '').trim()) {
      throw new AppError(422, 'SITE_ADDRESS_REQUIRED', '현장 주소를 먼저 입력해 주세요.');
    }
    if (!this.siteGeocoder || typeof this.siteGeocoder.geocode !== 'function') {
      throw new AppError(503, 'SITE_GEOCODER_NOT_CONFIGURED', '현장 주소 위치 변환 설정이 아직 완료되지 않았습니다.');
    }

    const resolved = await this.siteGeocoder.geocode(entity.siteAddress);
    if (!resolved) {
      throw new AppError(422, 'SITE_LOCATION_NOT_FOUND', '현장 주소의 위치를 찾을 수 없습니다. 주소를 확인해 주세요.');
    }

    const coordinates = normalizeSiteCoordinates(resolved);
    if (!coordinates) {
      throw new AppError(502, 'SITE_GEOCODER_INVALID_RESPONSE', '현장 주소 위치 정보를 확인할 수 없습니다.');
    }
    const updated = await updateCoordinates(coordinates, entity.siteAddress);
    if (!updated) {
      throw new AppError(409, 'SITE_ADDRESS_CHANGED', '현장 주소가 변경되어 위치를 저장하지 않았습니다. 다시 시도해 주세요.');
    }

    return {
      ...coordinates,
      matchedAddress: resolved.matchedAddress,
      provider: resolved.provider,
      source: 'geocoded',
    };
  }

  async updateSiteLocation({ coordinates: location, notFoundCode, notFoundMessage, updateCoordinates }) {
    const coordinates = clearsSiteCoordinates(location) ? null : normalizeSiteCoordinates(location);
    if (!coordinates && !clearsSiteCoordinates(location)) {
      throw new AppError(400, 'INVALID_SITE_COORDINATES', '현장 위도와 경도를 확인해 주세요.');
    }

    const updated = await updateCoordinates(coordinates);
    if (!updated) throw new AppError(404, notFoundCode, notFoundMessage);
    return coordinates ?? { siteLatitude: null, siteLongitude: null };
  }
}

function sameSiteAddress(first, second) {
  const firstAddress = normalizeSiteAddress(first?.siteAddress);
  const secondAddress = normalizeSiteAddress(second?.siteAddress);
  return Boolean(firstAddress && secondAddress && firstAddress === secondAddress);
}

module.exports = { AppService };
