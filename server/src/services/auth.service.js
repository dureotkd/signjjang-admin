const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  createReferralCode,
  createSmsCode,
  hashSmsCode,
  maskPhone,
  normalizePhone,
  smsCodeMatches,
} = require('../auth-utils');
const { AppError } = require('../errors');

const publicUser = (user) => ({
  bankAccount: user.bank_account ?? '',
  bankHolder: user.bank_holder ?? '',
  bankName: user.bank_name ?? '',
  birthYear: user.birth_year,
  businessRegistrationNo: user.business_registration_no ?? '',
  companyName: user.company_name,
  email: user.email,
  fullName: user.full_name,
  gender: user.gender,
  id: String(user.id),
  marketingAgreed: Boolean(user.marketing_agreed),
  phone: user.phone,
  profileImageUrl: user.profile_image_url ?? '',
  referralCode: user.referral_code,
});

class AuthService {
  constructor({ config, repository, smsService }) {
    this.config = config;
    this.repository = repository;
    this.smsService = smsService;
    this.devSmsVerifications = new Map();
  }

  createAccessToken(user) {
    return jwt.sign(
      { phone: user.phone, type: 'access' },
      this.config.jwt.secret,
      { subject: String(user.id) },
    );
  }

  createSmsVerificationToken({ phone, purpose, verificationId }) {
    return jwt.sign(
      {
        phone,
        purpose,
        type: 'sms_verification',
        verificationId: String(verificationId),
      },
      this.config.jwt.secret,
      { expiresIn: purpose === 'signup' ? '30m' : '10m' },
    );
  }

  async login({ password, phone }) {
    const user = await this.repository.findUserByPhone(phone);
    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '전화번호 또는 비밀번호를 확인해주세요.');
    }
    await this.repository.markLogin(user.id);
    return { accessToken: this.createAccessToken(user), user: publicUser(user) };
  }

  isSignupAccountUpdateAllowed(phone) {
    return (this.config.signup?.accountUpdatePhoneAllowlist ?? [])
      .some((allowedPhone) => normalizePhone(allowedPhone) === normalizePhone(phone));
  }

  async findSignupAccountToUpdate(phone) {
    if (!this.isSignupAccountUpdateAllowed(phone)) return null;
    const user = await this.repository.findUserByPhone(phone, { includeDeleted: true });
    if (user && (user.status !== 'active' || user.deleted_at)) {
      throw new AppError(409, 'ACCOUNT_UPDATE_UNAVAILABLE', '기존 계정 상태를 확인할 수 없습니다. 고객센터에 문의해주세요.');
    }
    return user;
  }

  async checkSignupPhoneAvailability(phone, { allowConfiguredDuplicatePhone = false } = {}) {
    const allowlist = this.config.sms.signupDuplicatePhoneAllowlist ?? [];
    if (allowConfiguredDuplicatePhone && (
      this.isSignupAccountUpdateAllowed(phone) ||
      allowlist.some((allowedPhone) => normalizePhone(allowedPhone) === normalizePhone(phone))
    )) {
      return;
    }
    if (await this.repository.findUserByPhone(phone, { includeDeleted: true })) {
      throw new AppError(409, 'PHONE_ALREADY_USED', '이미 가입된 전화번호입니다.');
    }
  }

  async sendSmsCode({ phone, purpose }) {
    if (purpose === 'signup') await this.checkSignupPhoneAvailability(phone, { allowConfiguredDuplicatePhone: true });
    if (this.config.sms.devMode) {
      const code = createSmsCode();
      const codeHash = hashSmsCode(phone, purpose, code, this.config.sms.codePepper);
      const key = `${purpose}:${phone}`;
      this.devSmsVerifications.set(key, {
        attempts: 0,
        codeHash,
        expiresAt: Date.now() + this.config.sms.codeTtlSeconds * 1000,
      });
      try {
        const sent = await this.smsService.sendVerificationCode(phone, code);
        return {
          devCode: sent.devCode ?? code,
          expiresInSeconds: this.config.sms.codeTtlSeconds,
        };
      } catch {
        this.devSmsVerifications.delete(key);
        throw new AppError(502, 'SMS_SEND_FAILED', '테스트 인증번호를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
    }

    if (purpose === 'password_reset') {
      const existingUser = await this.repository.findUserByPhone(phone);
      if (!existingUser) return { expiresInSeconds: this.config.sms.codeTtlSeconds };
    }

    const recentCount = await this.repository.countRecentSms(phone, purpose);
    if (recentCount >= 3) {
      throw new AppError(429, 'SMS_RATE_LIMITED', '인증번호 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
    }

    const code = createSmsCode();
    const codeHash = hashSmsCode(phone, purpose, code, this.config.sms.codePepper);
    const expiresAt = new Date(Date.now() + this.config.sms.codeTtlSeconds * 1000);
    const verificationId = await this.repository.createSmsVerification({ codeHash, expiresAt, phone, purpose });

    try {
      const sent = await this.smsService.sendVerificationCode(phone, code);
      if (sent.providerMessageId) {
        await this.repository.setSmsProviderMessageId(verificationId, sent.providerMessageId);
      }
      return {
        devCode: this.config.sms.devMode ? sent.devCode : undefined,
        expiresInSeconds: this.config.sms.codeTtlSeconds,
      };
    } catch (error) {
      await this.repository.deleteSmsVerification(verificationId);
      throw new AppError(502, 'SMS_SEND_FAILED', '문자 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  async verifySmsCode({ code, phone, purpose }) {
    if (purpose === 'signup') await this.checkSignupPhoneAvailability(phone, { allowConfiguredDuplicatePhone: true });
    if (this.config.sms.devMode) {
      const key = `${purpose}:${phone}`;
      const verification = this.devSmsVerifications.get(key);
      const candidateHash = hashSmsCode(phone, purpose, code, this.config.sms.codePepper);
      if (
        !verification ||
        verification.expiresAt <= Date.now() ||
        verification.attempts >= 5 ||
        !smsCodeMatches(verification.codeHash, candidateHash)
      ) {
        if (verification) {
          verification.attempts += 1;
          if (verification.expiresAt <= Date.now() || verification.attempts >= 5) {
            this.devSmsVerifications.delete(key);
          }
        }
        throw new AppError(401, 'INVALID_VERIFICATION_CODE', '인증번호가 만료되었거나 올바르지 않습니다.');
      }

      this.devSmsVerifications.delete(key);
      return {
        verificationToken: this.createSmsVerificationToken({
          phone,
          purpose,
          verificationId: 'dev',
        }),
      };
    }

    const verification = await this.repository.findLatestActiveSms(phone, purpose);
    if (!verification || verification.verified_at || verification.consumed_at || verification.attempts >= 5) {
      throw new AppError(401, 'INVALID_VERIFICATION_CODE', '인증번호가 만료되었거나 올바르지 않습니다.');
    }
    const candidateHash = hashSmsCode(phone, purpose, code, this.config.sms.codePepper);
    if (!smsCodeMatches(verification.code_hash, candidateHash)) {
      await this.repository.incrementSmsAttempts(verification.id);
      throw new AppError(401, 'INVALID_VERIFICATION_CODE', '인증번호가 만료되었거나 올바르지 않습니다.');
    }
    const verificationToken = this.createSmsVerificationToken({ phone, purpose, verificationId: verification.id });
    const expiresAt = new Date(jwt.decode(verificationToken).exp * 1000);
    if (!(await this.repository.markSmsVerified(verification.id, expiresAt))) {
      throw new AppError(401, 'INVALID_VERIFICATION_CODE', '인증번호가 만료되었거나 올바르지 않습니다.');
    }
    return { verificationToken };
  }

  verifySmsToken(token, purpose, expectedPhone) {
    try {
      const payload = jwt.verify(token, this.config.jwt.secret);
      if (
        typeof payload !== 'object' ||
        payload.type !== 'sms_verification' ||
        payload.purpose !== purpose ||
        payload.phone !== expectedPhone ||
        !payload.verificationId
      ) {
        throw new Error('invalid token claims');
      }
      if (payload.verificationId === 'dev' && this.config.sms.devMode) return 0;
      const verificationId = Number(payload.verificationId);
      if (!Number.isSafeInteger(verificationId) || verificationId <= 0) {
        throw new Error('invalid verification id');
      }
      return verificationId;
    } catch {
      throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해주세요.');
    }
  }

  async checkSignupAvailability(input, { allowConfiguredDuplicatePhone = false } = {}) {
    const verificationId = this.verifySmsToken(input.smsVerificationToken, 'signup', input.phone);
    if (verificationId > 0) {
      const verification = await this.repository.findLatestActiveSms(input.phone, 'signup');
      if (
        !verification || Number(verification.id) !== verificationId ||
        !verification.verified_at || verification.consumed_at
      ) {
        throw new AppError(401, 'VERIFICATION_EXPIRED', '휴대폰 인증을 다시 진행해주세요.');
      }
    }
    const existingUser = await this.findSignupAccountToUpdate(input.phone);
    if (existingUser && verificationId <= 0) {
      throw new AppError(401, 'VERIFICATION_EXPIRED', '기존 계정 정보를 갱신하려면 실제 문자 인증을 완료해주세요.');
    }
    if (!existingUser) await this.checkSignupPhoneAvailability(input.phone, { allowConfiguredDuplicatePhone });
    const emailUser = input.email ? await this.repository.findUserByEmail(input.email) : null;
    if (emailUser && (!existingUser || String(emailUser.id) !== String(existingUser.id))) {
      throw new AppError(409, 'EMAIL_ALREADY_USED', '이미 사용 중인 이메일입니다. 다른 이메일을 입력해주세요.');
    }
    return verificationId;
  }

  async checkSignupBusiness(input) {
    await this.checkSignupAvailability(input, { allowConfiguredDuplicatePhone: true });
    return { available: true };
  }

  async signup(input) {
    const verificationId = await this.checkSignupAvailability(input);
    const existingUser = await this.findSignupAccountToUpdate(input.phone);

    let referredByUserId = null;
    if (!existingUser && input.referralCode) {
      const referrer = await this.repository.findUserByReferralCode(input.referralCode.toUpperCase());
      if (!referrer) {
        throw new AppError(400, 'INVALID_REFERRAL_CODE', '추천인 코드를 확인해주세요.');
      }
      referredByUserId = referrer.id;
    }

    let referralCode = existingUser?.referral_code;
    if (!existingUser) {
      do {
        referralCode = createReferralCode();
      } while (await this.repository.findUserByReferralCode(referralCode));
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    let userId;
    try {
      if (existingUser) {
        userId = await this.repository.updateUserWithVerification({
          ...input,
          passwordHash,
          userId: existingUser.id,
          verificationId,
        });
      } else {
        userId = await this.repository.createUserWithVerification({
          ...input,
          passwordHash,
          referralCode,
          referredByUserId,
          verificationId,
        });
      }
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        if (existingUser) {
          throw new AppError(409, 'EMAIL_ALREADY_USED', '이미 사용 중인 이메일입니다. 다른 이메일을 입력해주세요.');
        }
        throw new AppError(409, 'DUPLICATE_USER', '이미 사용 중인 전화번호 또는 이메일입니다.');
      }
      throw error;
    }

    const user = await this.repository.findUserByPhone(input.phone);
    return {
      accessToken: this.createAccessToken({ ...user, id: userId }),
      accountUpdated: Boolean(existingUser),
      user: publicUser(user),
    };
  }

  async findPhone({ companyName, fullName }) {
    const user = await this.repository.findUserByIdentity(companyName, fullName);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', '일치하는 회원정보가 없습니다.');
    }
    return { maskedPhone: maskPhone(user.phone) };
  }

  async resetPassword({ newPassword, phone, smsVerificationToken }) {
    const verificationId = this.verifySmsToken(smsVerificationToken, 'password_reset', phone);
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.repository.resetPasswordWithVerification({ passwordHash, phone, verificationId });
    return { message: '비밀번호가 변경되었습니다.' };
  }
}

module.exports = { AuthService };
