const { normalizeSiteCoordinates, withSiteCoordinates } = require('../site-location');
const { AppError } = require('../errors');
const { contractWorkDate, isContractPaid, scheduleFromContract, scheduleStateForUpdate, statusForDate } = require('../workflow');

const assertContractEditable = (contract, schedules) => {
  if (isContractPaid(contract, schedules)) {
    throw new AppError(409, 'CONTRACT_PAYMENT_COMPLETED', '수금완료된 계약서는 수정할 수 없습니다.');
  }
};

const parseJson = (value) => {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const isoDate = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};

const isoDateTime = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return new Date(value).toISOString();
  return value.toISOString();
};

const toProfile = (row) => ({
  bankAccount: row.bank_account ?? '',
  bankHolder: row.bank_holder ?? '',
  bankName: row.bank_name ?? '',
  birthYear: row.birth_year == null ? null : Number(row.birth_year),
  businessRegistrationNo: row.business_registration_no ?? '',
  companyName: row.company_name,
  email: row.email ?? '',
  fullName: row.full_name,
  gender: row.gender,
  id: String(row.id),
  marketingAgreed: Boolean(row.marketing_agreed),
  phone: row.phone,
  profileImageUrl: row.profile_image_url ?? '',
  referralCode: row.referral_code,
});

const toEquipment = (row) => ({
  category: row.category,
  id: String(row.id),
  image: row.image_key || 'sampleMachinery',
  tonnage: row.specification ?? '',
  vehicleNo: row.vehicle_no ?? '',
});

const coordinatesFromRow = (row, payload) => (
  normalizeSiteCoordinates({
    siteLatitude: row.site_latitude,
    siteLongitude: row.site_longitude,
  }) ?? normalizeSiteCoordinates(payload)
);

const payloadForStorage = (entity) => {
  const coordinates = normalizeSiteCoordinates(entity);
  return {
    coordinates,
    payload: withSiteCoordinates(entity, coordinates),
  };
};

const coordinatePayloadUpdate = (coordinates) => {
  if (!coordinates) {
    return {
      parameters: [],
      sql: "JSON_REMOVE(payload, '$.siteLatitude', '$.siteLongitude')",
    };
  }
  return {
    parameters: [coordinates.siteLatitude, coordinates.siteLongitude],
    sql: "JSON_SET(JSON_REMOVE(payload, '$.siteLatitude', '$.siteLongitude'), '$.siteLatitude', ?, '$.siteLongitude', ?)",
  };
};

const toContract = (row) => {
  const payload = parseJson(row.payload);
  const coordinates = coordinatesFromRow(row, payload);
  return {
    ...withSiteCoordinates(payload, coordinates),
    fee: Number(row.fee),
    id: String(row.id),
    progress: row.progress,
    startDate: isoDate(row.start_date),
    status: row.status,
    smsSentAt: isoDateTime(row.sms_sent_at),
    confirmerSmsSentAt: isoDateTime(row.confirmer_sms_sent_at),
    ordererSmsSentAt: isoDateTime(row.orderer_sms_sent_at),
    type: row.type,
    updatedAt: isoDateTime(row.updated_at),
  };
};

const toSchedule = (row) => {
  const payload = parseJson(row.payload);
  const coordinates = coordinatesFromRow(row, payload);
  return {
    ...withSiteCoordinates(payload, coordinates),
    contractId: row.contract_id == null ? undefined : String(row.contract_id),
    date: isoDate(row.work_date),
    fee: Number(row.fee),
    id: String(row.id),
    settlement: row.settlement,
    status: row.status,
  };
};

const toAlliance = (row) => ({
  contactName: row.contact_name,
  createdAt: isoDateTime(row.created_at),
  id: String(row.id),
  phone: row.phone,
  tradeName: row.trade_name,
});

const toDocument = (row) => ({
  documentType: row.document_type,
  expiresOn: isoDate(row.expires_on),
  fileUrl: `/api/documents/${row.id}/file`,
  id: String(row.id),
  label: row.label,
  mimeType: row.mime_type ?? '',
  originalName: row.original_name ?? '',
  updatedAt: isoDateTime(row.updated_at),
});

const toInquiry = (row) => ({
  answer: row.answer ?? '',
  answered: Boolean(row.answered_at),
  answeredAt: isoDateTime(row.answered_at),
  content: row.content,
  createdAt: isoDateTime(row.created_at),
  id: String(row.id),
  title: row.title,
});

const toNotice = (row) => ({
  body: row.body,
  id: String(row.id),
  publishedAt: isoDateTime(row.published_at),
  slug: row.slug,
  title: row.title,
});

class AppRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async transaction(operation) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getProfile(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, phone, company_name, business_registration_no, full_name, gender,
              birth_year, email, profile_image_url, bank_name, bank_account, bank_holder,
              marketing_agreed, referral_code
       FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [userId],
    );
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async updateProfile(userId, profile) {
    const [result] = await this.pool.execute(
      `UPDATE users
       SET full_name = ?, company_name = ?, business_registration_no = ?, gender = ?,
           birth_year = ?, email = ?, marketing_agreed = ?, updated_at = NOW(3)
       WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
      [
        profile.fullName,
        profile.companyName,
        profile.businessRegistrationNo || null,
        profile.gender,
        profile.birthYear,
        profile.email || null,
        profile.marketingAgreed ? 1 : 0,
        userId,
      ],
    );
    return result.affectedRows;
  }

  async updateBankAccount(userId, bank) {
    const [result] = await this.pool.execute(
      `UPDATE users SET bank_name = ?, bank_account = ?, bank_holder = ?, updated_at = NOW(3)
       WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
      [bank.bankName, bank.accountNumber, bank.holderName, userId],
    );
    return result.affectedRows;
  }

  async updateProfileImage(userId, profileImageUrl) {
    const [result] = await this.pool.execute(
      `UPDATE users SET profile_image_url = ?, updated_at = NOW(3)
       WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
      [profileImageUrl, userId],
    );
    return result.affectedRows;
  }

  async deleteAccount(userId) {
    const [result] = await this.pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    return result.affectedRows;
  }

  async listEquipments(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, category, specification, vehicle_no, image_key
       FROM user_equipments WHERE user_id = ? ORDER BY id`,
      [userId],
    );
    return rows.map(toEquipment);
  }

  async replaceEquipments(userId, equipments) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM user_equipments WHERE user_id = ?', [userId]);
      for (const equipment of equipments) {
        await connection.execute(
          `INSERT INTO user_equipments (user_id, category, specification, vehicle_no, image_key)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, equipment.category, equipment.tonnage || null, equipment.vehicleNo || null, equipment.image || null],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.listEquipments(userId);
  }

  async listContracts(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, type, status, progress, start_date, fee, site_latitude, site_longitude, payload, updated_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent') AS sms_sent_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent' AND d.recipient_type = '확인자') AS confirmer_sms_sent_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent' AND d.recipient_type IN ('오더주', '발주자')) AS orderer_sms_sent_at
       FROM contracts WHERE user_id = ? ORDER BY start_date DESC, id DESC`,
      [userId],
    );
    return rows.map(toContract);
  }

  async getContract(userId, contractId, executor = this.pool, lock = false) {
    const [rows] = await executor.execute(
      `SELECT id, type, status, progress, start_date, fee, site_latitude, site_longitude, payload, updated_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent') AS sms_sent_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent' AND d.recipient_type = '확인자') AS confirmer_sms_sent_at,
         (SELECT MAX(d.created_at) FROM contract_deliveries d
          WHERE d.contract_id = contracts.id AND d.user_id = contracts.user_id AND d.status = 'sent' AND d.recipient_type IN ('오더주', '발주자')) AS orderer_sms_sent_at
       FROM contracts WHERE id = ? AND user_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [contractId, userId],
    );
    return rows[0] ? toContract(rows[0]) : null;
  }

  async createContract(userId, contract) {
    return this.transaction(async (connection) => {
      const next = { ...contract, progress: statusForDate(contract.progress, contractWorkDate(contract)) };
      const { coordinates, payload } = payloadForStorage(next);
      const [result] = await connection.execute(
        `INSERT INTO contracts
         (user_id, type, status, progress, start_date, fee, site_latitude, site_longitude, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          contract.type,
          contract.status,
          next.progress,
          contract.startDate,
          contract.fee,
          coordinates?.siteLatitude ?? null,
          coordinates?.siteLongitude ?? null,
          JSON.stringify(payload),
        ],
      );
      const saved = await this.getContract(userId, result.insertId, connection);
      if (saved.status !== 'draft') {
        await this.writeSchedule(connection, userId, scheduleFromContract(saved));
      }
      return saved;
    });
  }

  async updateContract(userId, contractId, contract) {
    return this.transaction(async (connection) => {
      const existing = await this.getContract(userId, contractId, connection, true);
      if (!existing) return null;
      const linkedSchedules = await this.getContractSchedules(userId, contractId, connection);
      assertContractEditable(existing, linkedSchedules);
      const linked = linkedSchedules[0];
      const schedule = linked || contract.status !== 'draft'
        ? scheduleFromContract({ ...contract, id: String(contractId) }, linked)
        : null;
      const next = { ...contract, progress: schedule?.status ?? statusForDate(contract.progress, contractWorkDate(contract)) };
      const { coordinates, payload } = payloadForStorage(next);
      await connection.execute(
        `UPDATE contracts
         SET type = ?, status = ?, progress = ?, start_date = ?, fee = ?,
             site_latitude = ?, site_longitude = ?, payload = ?, updated_at = NOW(3)
         WHERE id = ? AND user_id = ?`,
        [
          contract.type,
          contract.status,
          next.progress,
          contract.startDate,
          contract.fee,
          coordinates?.siteLatitude ?? null,
          coordinates?.siteLongitude ?? null,
          JSON.stringify(payload),
          contractId,
          userId,
        ],
      );
      if (schedule) await this.writeSchedule(connection, userId, schedule, linked?.id);
      return this.getContract(userId, contractId, connection);
    });
  }

  async updateContractSiteCoordinates(userId, contractId, coordinates, { expectedSiteAddress } = {}) {
    const normalized = coordinates === null ? null : normalizeSiteCoordinates(coordinates);
    if (coordinates !== null && !normalized) return null;
    const payloadUpdate = coordinatePayloadUpdate(normalized);
    const addressCondition = expectedSiteAddress === undefined
      ? ''
      : " AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.siteAddress')) <=> ?";
    const [result] = await this.pool.execute(
      `UPDATE contracts
       SET site_latitude = ?, site_longitude = ?, payload = ${payloadUpdate.sql}, updated_at = NOW(3)
       WHERE id = ? AND user_id = ?${addressCondition}`,
      [
        normalized?.siteLatitude ?? null,
        normalized?.siteLongitude ?? null,
        ...payloadUpdate.parameters,
        contractId,
        userId,
        ...(expectedSiteAddress === undefined ? [] : [String(expectedSiteAddress ?? '')]),
      ],
    );
    return result.affectedRows ? this.getContract(userId, contractId) : null;
  }

  async deleteContract(userId, contractId) {
    return this.transaction(async (connection) => {
      if (!await this.getContract(userId, contractId, connection, true)) return 0;
      // Removing a document must not erase the driver's work/sales ledger.
      await connection.execute(
        `UPDATE schedules SET contract_id = NULL,
         payload = JSON_REMOVE(payload, '$.contractId'), updated_at = NOW(3)
         WHERE user_id = ? AND contract_id = ?`,
        [userId, contractId],
      );
      const [result] = await connection.execute('DELETE FROM contracts WHERE id = ? AND user_id = ?', [contractId, userId]);
      return result.affectedRows;
    });
  }

  async createContractDelivery(userId, contractId, delivery) {
    const [result] = await this.pool.execute(
      `INSERT INTO contract_deliveries
       (contract_id, user_id, recipient_type, recipient_phone, include_work_photos, status, provider_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contractId,
        userId,
        delivery.recipientType,
        delivery.recipientPhone,
        delivery.includeWorkPhotos ? 1 : 0,
        delivery.status,
        delivery.providerMessageId || null,
      ],
    );
    return { id: String(result.insertId), status: delivery.status, contract: await this.getContract(userId, contractId) };
  }

  async listSchedules(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, contract_id, work_date, status, settlement, fee, site_latitude, site_longitude, payload
       FROM schedules WHERE user_id = ? ORDER BY work_date DESC, id DESC`,
      [userId],
    );
    return rows.map(toSchedule);
  }

  async getSchedule(userId, scheduleId, executor = this.pool, lock = false) {
    const [rows] = await executor.execute(
      `SELECT id, contract_id, work_date, status, settlement, fee, site_latitude, site_longitude, payload
       FROM schedules WHERE id = ? AND user_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [scheduleId, userId],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  async getContractSchedule(userId, contractId, connection) {
    const [rows] = await connection.execute(
      `SELECT id, contract_id, work_date, status, settlement, fee, site_latitude, site_longitude, payload
       FROM schedules WHERE user_id = ? AND contract_id = ? ORDER BY id LIMIT 1 FOR UPDATE`,
      [userId, contractId],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  async getContractSchedules(userId, contractId, connection) {
    const [rows] = await connection.execute(
      `SELECT id, contract_id, work_date, status, settlement, fee, site_latitude, site_longitude, payload
       FROM schedules WHERE user_id = ? AND contract_id = ? ORDER BY id FOR UPDATE`,
      [userId, contractId],
    );
    return rows.map(toSchedule);
  }

  async createSchedule(userId, schedule) {
    return this.transaction(async (connection) => {
      if (schedule.contractId) {
        // The contract row serializes concurrent retries, including old APKs
        // which still POST an extra schedule after completing the document.
        const contract = await this.getContract(userId, schedule.contractId, connection, true);
        if (!contract) throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');
        const existing = await this.getContractSchedule(userId, schedule.contractId, connection);
        if (existing) return existing;
        return this.writeSchedule(connection, userId, scheduleFromContract(contract));
      }
      return this.writeSchedule(connection, userId, {
        ...schedule, status: statusForDate(schedule.status, schedule.date),
      });
    });
  }

  async writeSchedule(connection, userId, schedule, scheduleId) {
    const { coordinates, payload } = payloadForStorage(schedule);
    if (scheduleId) {
      await connection.execute(
        `UPDATE schedules
         SET contract_id = ?, work_date = ?, status = ?, settlement = ?, fee = ?,
             site_latitude = ?, site_longitude = ?, payload = ?, updated_at = NOW(3)
         WHERE id = ? AND user_id = ?`,
        [
          schedule.contractId || null, schedule.date, schedule.status, schedule.settlement, schedule.fee,
          coordinates?.siteLatitude ?? null, coordinates?.siteLongitude ?? null, JSON.stringify(payload),
          scheduleId, userId,
        ],
      );
      return this.getSchedule(userId, scheduleId, connection);
    }
    const [result] = await connection.execute(
      `INSERT INTO schedules
       (user_id, contract_id, work_date, status, settlement, fee, site_latitude, site_longitude, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        schedule.contractId || null,
        schedule.date,
        schedule.status,
        schedule.settlement,
        schedule.fee,
        coordinates?.siteLatitude ?? null,
        coordinates?.siteLongitude ?? null,
        JSON.stringify(payload),
      ],
    );
    return this.getSchedule(userId, result.insertId, connection);
  }

  async updateSchedule(userId, scheduleId, schedule, { statusOnly = false } = {}) {
    return this.transaction(async (connection) => {
      const previous = await this.getSchedule(userId, scheduleId, connection);
      if (!previous) return null;
      const collectionAction = ['settled', 'unpaid'].includes(schedule.status);
      const stateOnly = statusOnly || Boolean(previous.contractId && collectionAction);
      const contractId = stateOnly ? previous.contractId : schedule.contractId;
      // Lock the persisted link as well as a requested new link. Omitting or
      // replacing contractId must not bypass a paid contract's edit lock.
      const contractIds = [...new Set([previous.contractId, contractId].filter(Boolean))].sort((left, right) => Number(left) - Number(right));
      const contracts = new Map();
      for (const id of contractIds) {
        const linkedContract = await this.getContract(userId, id, connection, true);
        if (!linkedContract) throw new AppError(404, 'CONTRACT_NOT_FOUND', '계약서를 찾을 수 없습니다.');
        contracts.set(String(id), linkedContract);
      }
      const existing = await this.getSchedule(userId, scheduleId, connection, true);
      if (!existing) return null;
      if (String(existing.contractId ?? '') !== String(previous.contractId ?? '')) {
        throw new AppError(409, 'SCHEDULE_CHANGED', '일정 정보가 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.');
      }
      const contract = contracts.get(String(contractId)) ?? null;
      if (!stateOnly) {
        for (const id of contractIds) {
          assertContractEditable(contracts.get(String(id)), await this.getContractSchedules(userId, id, connection));
        }
      }
      // Historical duplicates still accept collection corrections. Only
      // creating a NEW competing link is prohibited.
      if (contract && String(existing.contractId ?? '') !== String(contractId)) {
        const linked = await this.getContractSchedule(userId, contractId, connection);
        if (linked && linked.id !== String(scheduleId)) {
          throw new AppError(409, 'CONTRACT_SCHEDULE_EXISTS', '이 계약서에 연결된 일정이 이미 있습니다.');
        }
      }
      let next;
      if (contract) {
        // Older screens send the entire cached schedule for a status change.
        // Read the locked contract as the source of dates, amounts and site
        // details so collecting payment cannot undo a newer contract edit.
        const current = scheduleFromContract(contract, existing);
        next = { ...current, ...scheduleStateForUpdate(current, schedule, { preserveSettlement: stateOnly }) };
      } else {
        const current = stateOnly ? existing : { ...existing, date: schedule.date };
        next = { ...(stateOnly ? existing : schedule), ...scheduleStateForUpdate(current, schedule, { preserveSettlement: stateOnly }) };
      }
      const saved = await this.writeSchedule(connection, userId, next, scheduleId);
      if (next.contractId) {
        await connection.execute(
          `UPDATE contracts SET progress = ?, payload = JSON_SET(payload, '$.progress', ?), updated_at = NOW(3)
           WHERE id = ? AND user_id = ?`,
          [next.status, next.status, next.contractId, userId],
        );
      }
      return saved;
    });
  }

  async updateScheduleSiteCoordinates(userId, scheduleId, coordinates, { expectedSiteAddress } = {}) {
    const normalized = coordinates === null ? null : normalizeSiteCoordinates(coordinates);
    if (coordinates !== null && !normalized) return null;
    const payloadUpdate = coordinatePayloadUpdate(normalized);
    const addressCondition = expectedSiteAddress === undefined
      ? ''
      : " AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.siteAddress')) <=> ?";
    const [result] = await this.pool.execute(
      `UPDATE schedules
       SET site_latitude = ?, site_longitude = ?, payload = ${payloadUpdate.sql}, updated_at = NOW(3)
       WHERE id = ? AND user_id = ?${addressCondition}`,
      [
        normalized?.siteLatitude ?? null,
        normalized?.siteLongitude ?? null,
        ...payloadUpdate.parameters,
        scheduleId,
        userId,
        ...(expectedSiteAddress === undefined ? [] : [String(expectedSiteAddress ?? '')]),
      ],
    );
    return result.affectedRows ? this.getSchedule(userId, scheduleId) : null;
  }

  async deleteSchedule(userId, scheduleId) {
    const [result] = await this.pool.execute('DELETE FROM schedules WHERE id = ? AND user_id = ?', [scheduleId, userId]);
    return result.affectedRows;
  }

  async listAlliances(userId) {
    const [rows] = await this.pool.execute(
      'SELECT id, trade_name, contact_name, phone, created_at FROM alliances WHERE user_id = ? ORDER BY id DESC',
      [userId],
    );
    return rows.map(toAlliance);
  }

  async createAlliance(userId, alliance) {
    let result;
    try {
      [result] = await this.pool.execute(
        'INSERT INTO alliances (user_id, trade_name, contact_name, phone) VALUES (?, ?, ?, ?)',
        [userId, alliance.tradeName, alliance.contactName, alliance.phone],
      );
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw new AppError(409, 'CONTACT_ALREADY_EXISTS', '이미 등록된 전화번호입니다. 연락처 목록에서 확인해 주세요.');
      }
      throw error;
    }
    const [rows] = await this.pool.execute(
      'SELECT id, trade_name, contact_name, phone, created_at FROM alliances WHERE id = ? AND user_id = ?',
      [result.insertId, userId],
    );
    return toAlliance(rows[0]);
  }

  async updateAllianceByPhone(userId, alliance) {
    await this.pool.execute(
      'UPDATE alliances SET trade_name = ?, contact_name = ? WHERE user_id = ? AND phone = ?',
      [alliance.tradeName, alliance.contactName, userId, alliance.phone],
    );
    const [rows] = await this.pool.execute(
      'SELECT id, trade_name, contact_name, phone, created_at FROM alliances WHERE user_id = ? AND phone = ?',
      [userId, alliance.phone],
    );
    return rows[0] ? toAlliance(rows[0]) : null;
  }

  async importContacts(userId, contacts) {
    const placeholders = contacts.map(() => '(?, ?, ?, ?)').join(', ');
    const values = contacts.flatMap((contact) => [
      userId,
      contact.tradeName || '개인 연락처',
      contact.contactName,
      contact.phone,
    ]);
    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO alliances (user_id, trade_name, contact_name, phone) VALUES ${placeholders}`,
      values,
    );
    return { imported: result.affectedRows, skipped: contacts.length - result.affectedRows };
  }

  async listDocuments(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, document_type, label, file_url, original_name, mime_type, expires_on, updated_at
       FROM user_documents WHERE user_id = ? ORDER BY id DESC`,
      [userId],
    );
    return rows.map(toDocument);
  }

  async createDocument(userId, document) {
    const [result] = await this.pool.execute(
      `INSERT INTO user_documents
       (user_id, document_type, label, file_url, original_name, mime_type, expires_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        document.documentType,
        document.label,
        document.fileUrl,
        document.originalName,
        document.mimeType,
        document.expiresOn || null,
      ],
    );
    const [rows] = await this.pool.execute(
      `SELECT id, document_type, label, file_url, original_name, mime_type, expires_on, updated_at
       FROM user_documents WHERE id = ? AND user_id = ?`,
      [result.insertId, userId],
    );
    return toDocument(rows[0]);
  }

  async getDocumentFile(userId, documentId) {
    const [rows] = await this.pool.execute(
      'SELECT id, file_url, mime_type, original_name FROM user_documents WHERE id = ? AND user_id = ? LIMIT 1',
      [documentId, userId],
    );
    return rows[0] ?? null;
  }

  async deleteDocument(userId, documentId) {
    const [result] = await this.pool.execute(
      'DELETE FROM user_documents WHERE id = ? AND user_id = ?',
      [documentId, userId],
    );
    return result.affectedRows;
  }

  async listInquiries(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, title, content, answer, answered_at, created_at
       FROM inquiries WHERE user_id = ? ORDER BY id DESC`,
      [userId],
    );
    return rows.map(toInquiry);
  }

  async getInquiry(userId, inquiryId) {
    const [rows] = await this.pool.execute(
      `SELECT id, title, content, answer, answered_at, created_at
       FROM inquiries WHERE id = ? AND user_id = ? LIMIT 1`,
      [inquiryId, userId],
    );
    return rows[0] ? toInquiry(rows[0]) : null;
  }

  async createInquiry(userId, inquiry) {
    const [result] = await this.pool.execute(
      'INSERT INTO inquiries (user_id, title, content) VALUES (?, ?, ?)',
      [userId, inquiry.title, inquiry.content],
    );
    return this.getInquiry(userId, result.insertId);
  }

  async listNotices() {
    const [rows] = await this.pool.execute(
      `SELECT id, slug, title, body, published_at FROM notices
       WHERE published_at <= NOW(3) ORDER BY published_at DESC`,
    );
    return rows.map(toNotice);
  }

  async getNotice(noticeId) {
    const [rows] = await this.pool.execute(
      'SELECT id, slug, title, body, published_at FROM notices WHERE id = ? AND published_at <= NOW(3) LIMIT 1',
      [noticeId],
    );
    return rows[0] ? toNotice(rows[0]) : null;
  }

  async getTerms(slug) {
    const [rows] = await this.pool.execute(
      'SELECT slug, title, body, version, effective_on, updated_at FROM terms_content WHERE slug = ? LIMIT 1',
      [slug],
    );
    if (!rows[0]) return null;
    return {
      body: rows[0].body,
      effectiveOn: isoDate(rows[0].effective_on),
      slug: rows[0].slug,
      title: rows[0].title,
      updatedAt: isoDateTime(rows[0].updated_at),
      version: rows[0].version,
    };
  }
}

module.exports = {
  AppRepository,
  toContract,
  toSchedule,
};
