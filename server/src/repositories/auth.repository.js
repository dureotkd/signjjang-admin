const { AppError } = require('../errors');

const userSelect = `
  SELECT id, phone, password_hash, company_name, business_registration_no,
         full_name, gender, birth_year, email, profile_image_url,
         bank_name, bank_account, bank_holder, marketing_agreed, referral_code, status, deleted_at
  FROM users
`;

class AuthRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findUserByPhone(phone, { includeDeleted = false } = {}) {
    const [rows] = await this.pool.execute(
      `${userSelect} WHERE phone = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'} LIMIT 1`,
      [phone],
    );
    return rows[0] ?? null;
  }

  async findUserByEmail(email) {
    // Email stays unique even when the account has been soft-deleted.
    const [rows] = await this.pool.execute(`${userSelect} WHERE email = ? LIMIT 1`, [email]);
    return rows[0] ?? null;
  }

  async findUserByIdentity(companyName, fullName) {
    const [rows] = await this.pool.execute(
      `${userSelect} WHERE company_name = ? AND full_name = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
      [companyName, fullName],
    );
    return rows[0] ?? null;
  }

  async findUserByReferralCode(referralCode) {
    const [rows] = await this.pool.execute(
      `${userSelect} WHERE referral_code = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [referralCode],
    );
    return rows[0] ?? null;
  }

  async countRecentSms(phone, purpose) {
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) AS count
       FROM sms_verifications
       WHERE phone = ? AND purpose = ? AND created_at >= DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`,
      [phone, purpose],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async createSmsVerification({ codeHash, expiresAt, phone, purpose }) {
    const [result] = await this.pool.execute(
      `INSERT INTO sms_verifications (phone, purpose, code_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
      [phone, purpose, codeHash, expiresAt],
    );
    return result.insertId;
  }

  async setSmsProviderMessageId(id, providerMessageId) {
    await this.pool.execute(
      'UPDATE sms_verifications SET provider_message_id = ? WHERE id = ?',
      [providerMessageId, id],
    );
  }

  async deleteSmsVerification(id) {
    await this.pool.execute('DELETE FROM sms_verifications WHERE id = ?', [id]);
  }

  async findLatestActiveSms(phone, purpose) {
    const [rows] = await this.pool.execute(
      `SELECT id, phone, purpose, code_hash, attempts, expires_at, verified_at, consumed_at
       FROM sms_verifications
       WHERE phone = ? AND purpose = ? AND expires_at > NOW(3) AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [phone, purpose],
    );
    return rows[0] ?? null;
  }

  async incrementSmsAttempts(id) {
    await this.pool.execute('UPDATE sms_verifications SET attempts = attempts + 1 WHERE id = ?', [id]);
  }

  async markSmsVerified(id, expiresAt) {
    const [result] = await this.pool.execute(
      `UPDATE sms_verifications
       SET verified_at = NOW(3), expires_at = ?
       WHERE id = ? AND verified_at IS NULL AND consumed_at IS NULL
         AND expires_at > NOW(3) AND attempts < 5`,
      [expiresAt, id],
    );
    return result.affectedRows === 1;
  }

  async createUserWithVerification(input) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (input.verificationId > 0) {
        const [verification] = await connection.execute(
          `UPDATE sms_verifications
           SET consumed_at = NOW(3)
           WHERE id = ? AND phone = ? AND purpose = 'signup'
             AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW(3)`,
          [input.verificationId, input.phone],
        );
        if (verification.affectedRows !== 1) {
          throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해 주세요.');
        }
      }

      const [result] = await connection.execute(
        `INSERT INTO users
          (phone, password_hash, company_name, full_name, gender, birth_year, email,
           marketing_agreed, referral_code, referred_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.phone,
          input.passwordHash,
          input.companyName,
          input.fullName,
          input.gender,
          input.birthYear,
          input.email || null,
          input.marketingAgreed ? 1 : 0,
          input.referralCode,
          input.referredByUserId,
        ],
      );

      for (const equipment of input.equipments) {
        await connection.execute(
          'INSERT INTO user_equipments (user_id, category, specification) VALUES (?, ?, ?)',
          [
            result.insertId,
            typeof equipment === 'string' ? equipment : equipment.category,
            typeof equipment === 'string' ? null : equipment.tonnage,
          ],
        );
      }

      await connection.commit();
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateUserWithVerification(input) {
    if (!Number.isSafeInteger(input.verificationId) || input.verificationId <= 0) {
      throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해 주세요.');
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        `SELECT id FROM users
         WHERE id = ? AND phone = ? AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [input.userId, input.phone],
      );
      if (users.length !== 1) {
        throw new AppError(409, 'ACCOUNT_UPDATE_UNAVAILABLE', '기존 계정 상태가 변경되어 정보를 갱신할 수 없습니다. 다시 로그인해주세요.');
      }
      const [verification] = await connection.execute(
        `UPDATE sms_verifications
         SET consumed_at = NOW(3)
         WHERE id = ? AND phone = ? AND purpose = 'signup'
           AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW(3)`,
        [input.verificationId, input.phone],
      );
      if (verification.affectedRows !== 1) {
        throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해 주세요.');
      }

      await connection.execute(
        `UPDATE users
         SET password_hash = ?, company_name = ?, full_name = ?, gender = ?, birth_year = ?,
             email = ?, marketing_agreed = ?, updated_at = NOW(3)
         WHERE id = ? AND phone = ? AND status = 'active' AND deleted_at IS NULL`,
        [
          input.passwordHash, input.companyName, input.fullName, input.gender, input.birthYear ?? null,
          input.email || null, input.marketingAgreed ? 1 : 0, input.userId, input.phone,
        ],
      );

      // Keep existing equipment IDs, vehicle numbers and photos; add only new selections.
      for (const equipment of input.equipments) {
        const category = (typeof equipment === 'string' ? equipment : equipment.category).trim();
        const specification = typeof equipment === 'string' ? null : equipment.tonnage.trim() || null;
        const [existingEquipments] = await connection.execute(
          `SELECT id FROM user_equipments
           WHERE user_id = ? AND category = ? AND NULLIF(TRIM(specification), '') <=> ?
           LIMIT 1 FOR UPDATE`,
          [input.userId, category, specification],
        );
        if (existingEquipments.length > 0) continue;
        await connection.execute(
          'INSERT INTO user_equipments (user_id, category, specification) VALUES (?, ?, ?)',
          [input.userId, category, specification],
        );
      }
      await connection.commit();
      return input.userId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async resetPasswordWithVerification({ passwordHash, phone, verificationId }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (verificationId > 0) {
        const [verification] = await connection.execute(
          `UPDATE sms_verifications
           SET consumed_at = NOW(3)
           WHERE id = ? AND phone = ? AND purpose = 'password_reset'
             AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW(3)`,
          [verificationId, phone],
        );
        if (verification.affectedRows !== 1) {
          throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해 주세요.');
        }
      }
      const [result] = await connection.execute(
        `UPDATE users SET password_hash = ?, updated_at = NOW(3)
         WHERE phone = ? AND status = 'active' AND deleted_at IS NULL`,
        [passwordHash, phone],
      );
      if (result.affectedRows !== 1) {
        throw new AppError(404, 'USER_NOT_FOUND', '일치하는 회원정보가 없습니다.');
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markLogin(userId) {
    await this.pool.execute('UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [userId]);
  }
}

module.exports = { AuthRepository };
