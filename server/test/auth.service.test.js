const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { AuthService } = require('../src/services/auth.service');

const createDevService = (repository = {}) => new AuthService({
  config: {
    jwt: {
      expiresIn: '7d',
      secret: 'test-secret-that-is-long-enough-for-jwt-tests',
    },
    sms: {
      codePepper: 'test-pepper-that-is-long-enough-for-hashing',
      codeTtlSeconds: 180,
      devMode: true,
    },
  },
  repository,
  smsService: {
    async sendVerificationCode(_phone, code) {
      return { devCode: code, providerMessageId: null };
    },
  },
});

test('access tokens do not expire automatically', () => {
  const service = createDevService();
  const token = service.createAccessToken({ id: 42, phone: '01012345678' });
  const payload = jwt.verify(token, 'test-secret-that-is-long-enough-for-jwt-tests');

  assert.equal(payload.type, 'access');
  assert.equal(payload.sub, '42');
  assert.equal(Object.hasOwn(payload, 'exp'), false);
});

test('development signup SMS checks phone availability and keeps verification in memory', async () => {
  const service = createDevService({ async findUserByPhone() { return null; } });
  const phone = '01012345678';
  const sent = await service.sendSmsCode({ phone, purpose: 'signup' });

  assert.match(sent.devCode, /^\d{6}$/);
  assert.equal(sent.expiresInSeconds, 180);

  const verified = await service.verifySmsCode({
    code: sent.devCode,
    phone,
    purpose: 'signup',
  });
  assert.equal(service.verifySmsToken(verified.verificationToken, 'signup', phone), 0);
});

test('development SMS rejects an incorrect or already consumed code', async () => {
  const service = createDevService();
  const phone = '01098765432';
  const sent = await service.sendSmsCode({ phone, purpose: 'password_reset' });

  await assert.rejects(
    service.verifySmsCode({ code: sent.devCode === '999999' ? '000000' : '999999', phone, purpose: 'password_reset' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE',
  );

  await service.verifySmsCode({ code: sent.devCode, phone, purpose: 'password_reset' });
  await assert.rejects(
    service.verifySmsCode({ code: sent.devCode, phone, purpose: 'password_reset' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE',
  );
});

test('signup SMS rejects active and deleted reserved phones before provider dispatch in every mode', async () => {
  for (const devMode of [false, true]) {
    for (const deleted_at of [null, new Date()]) {
      const service = createDevService({
        async findUserByPhone(phone, options) {
          assert.equal(phone, '01012345678');
          assert.deepEqual(options, { includeDeleted: true });
          return { id: 1, phone, deleted_at };
        },
      });
      service.config.sms.devMode = devMode;
      let providerCalls = 0;
      service.smsService.sendVerificationCode = async () => { providerCalls += 1; return {}; };

      await assert.rejects(
        service.sendSmsCode({ phone: '01012345678', purpose: 'signup' }),
        (error) => error.code === 'PHONE_ALREADY_USED' && error.status === 409,
      );
      assert.equal(providerCalls, 0);
      assert.equal(service.devSmsVerifications.size, 0);
    }
  }
});

const createSignupSmsService = (devMode, expectedPhone = '01012345678') => {
  const state = { existingUser: null, existingEmailUser: null, verification: null, sentCode: null, providerCalls: 0, phoneLookups: 0, recentSmsCount: 0 };
  const service = createDevService({
    async findUserByPhone(phone, options) {
      assert.equal(phone, expectedPhone);
      if (options) assert.deepEqual(options, { includeDeleted: true });
      else assert.ok(state.existingUser, 'a normal account lookup is only expected after signup succeeds');
      state.phoneLookups += 1;
      return state.existingUser;
    },
    async findUserByEmail() { return state.existingEmailUser; },
    async countRecentSms() { return state.recentSmsCount; },
    async createSmsVerification(input) {
      state.verification = {
        id: 42, attempts: 0, phone: input.phone, purpose: input.purpose, code_hash: input.codeHash,
        expires_at: input.expiresAt, verified_at: null, consumed_at: null,
      };
      return 42;
    },
    async setSmsProviderMessageId(id, providerMessageId) {
      assert.equal(id, 42);
      state.verification.provider_message_id = providerMessageId;
    },
    async findLatestActiveSms() {
      return state.verification?.expires_at.getTime() > Date.now() && !state.verification.consumed_at ? state.verification : null;
    },
    async incrementSmsAttempts(id) { assert.equal(id, 42); state.verification.attempts += 1; },
    async markSmsVerified(id, expiresAt) {
      assert.equal(id, 42);
      if (state.verification.verified_at || state.verification.consumed_at || state.verification.expires_at.getTime() <= Date.now()) return false;
      state.verification.verified_at = new Date(Date.now());
      state.verification.expires_at = expiresAt;
      return true;
    },
  });
  service.config.sms.devMode = devMode;
  service.smsService.sendVerificationCode = async (phone, code) => {
    assert.equal(phone, expectedPhone);
    state.providerCalls += 1;
    state.sentCode = code;
    return { devCode: devMode ? code : undefined, providerMessageId: devMode ? null : 'provider-message-42' };
  };
  return { service, state };
};

test('signup SMS verification rechecks duplicate phones registered after sending in every mode', async () => {
  for (const devMode of [false, true]) {
    const { service, state } = createSignupSmsService(devMode);
    await service.sendSmsCode({ phone: '01012345678', purpose: 'signup' });
    state.existingUser = { id: 1, phone: '01012345678' };

    await assert.rejects(
      service.verifySmsCode({ code: state.sentCode, phone: '01012345678', purpose: 'signup' }),
      (error) => error.code === 'PHONE_ALREADY_USED',
    );
    assert.equal(state.phoneLookups, 2);
    assert.equal(state.providerCalls, 1);
    if (!devMode) assert.equal(state.verification.verified_at, null);
  }
});

test('real signup SMS sends through the provider and verifies the persisted code without exposing it', async () => {
  const { service, state } = createSignupSmsService(false);
  const result = await service.sendSmsCode({ phone: '01012345678', purpose: 'signup' });

  assert.equal(result.devCode, undefined);
  assert.equal(result.expiresInSeconds, 180);
  assert.equal(state.providerCalls, 1);
  assert.match(state.sentCode, /^\d{6}$/);
  assert.notEqual(state.verification.code_hash, state.sentCode);
  assert.equal(state.verification.provider_message_id, 'provider-message-42');
  const verified = await service.verifySmsCode({ code: state.sentCode, phone: '01012345678', purpose: 'signup' });
  assert.equal(service.verifySmsToken(verified.verificationToken, 'signup', '01012345678'), 42);
  assert.ok(state.verification.verified_at);
  assert.equal(state.phoneLookups, 2);
  assert.equal(service.devSmsVerifications.size, 0);
});

test('signup verification gives 30 minutes to finish the form while password reset stays at 10 minutes', () => {
  const service = createDevService();
  for (const [purpose, expectedSeconds] of [['signup', 1800], ['password_reset', 600]]) {
    const payload = jwt.decode(service.createSmsVerificationToken({ phone: '01012345678', purpose, verificationId: 42 }));
    assert.equal(payload.exp - payload.iat, expectedSeconds);
  }
});

test('verified signup can finish without a referral after the original three-minute OTP window', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const { service, state } = createSignupSmsService(false);
  const phone = '01012345678';
  const sent = await service.sendSmsCode({ phone, purpose: 'signup' });
  const originalOtpExpiry = state.verification.expires_at.getTime();
  assert.equal(originalOtpExpiry, now + 180_000);
  assert.equal(sent.expiresInSeconds, 180);
  now += 60_000;
  const { verificationToken } = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
  const proofExpiry = jwt.decode(verificationToken).exp * 1000;
  assert.equal(state.verification.expires_at.getTime(), proofExpiry);

  now += 12 * 60_000;
  assert.ok(now > originalOtpExpiry);
  const input = {
    phone, smsVerificationToken: verificationToken, email: 'member@example.com',
    companyName: '테스트 장비회사', fullName: '테스트 기사', password: 'Password1!', equipments: [],
  };
  assert.deepEqual(await service.checkSignupBusiness(input), { available: true });
  let insertedAccounts = 0;
  service.repository.findUserByReferralCode = async () => null;
  service.repository.createUserWithVerification = async ({ verificationId }) => {
    assert.equal(verificationId, 42);
    assert.ok(state.verification.verified_at);
    assert.equal(state.verification.consumed_at, null);
    assert.ok(state.verification.expires_at.getTime() > now);
    state.verification.consumed_at = new Date(now);
    state.existingUser = { id: 7, phone };
    insertedAccounts += 1;
    return 7;
  };
  const result = await service.signup(input);
  assert.equal(result.user.id, '7');
  assert.equal(result.accountUpdated, false);
  assert.equal(insertedAccounts, 1);
  await assert.rejects(service.signup(input), (error) => error.code === 'VERIFICATION_EXPIRED');
  assert.equal(insertedAccounts, 1);
});

test('unverified OTP still expires after three minutes and verified signup proof expires after 30 minutes', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const { service, state } = createSignupSmsService(false);
  const phone = '01012345678';
  await service.sendSmsCode({ phone, purpose: 'signup' });
  now += 180_000;
  await assert.rejects(
    service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE',
  );
  assert.equal(state.verification.verified_at, null);

  await service.sendSmsCode({ phone, purpose: 'signup' });
  const { verificationToken } = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
  now = jwt.decode(verificationToken).exp * 1000;
  await assert.rejects(
    service.checkSignupBusiness({ phone, smsVerificationToken: verificationToken, email: 'member@example.com' }),
    (error) => error.code === 'VERIFICATION_EXPIRED',
  );
});

test('a verified real OTP cannot be reused to extend its proof lifetime', async () => {
  const { service, state } = createSignupSmsService(false);
  const phone = '01012345678';
  await service.sendSmsCode({ phone, purpose: 'signup' });
  await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
  const expiresAt = state.verification.expires_at.getTime();
  await assert.rejects(
    service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE',
  );
  assert.equal(state.verification.expires_at.getTime(), expiresAt);
});

test('SMS verification does not issue a token if its atomic verification update loses a race', async () => {
  const { service, state } = createSignupSmsService(false);
  const phone = '01012345678';
  await service.sendSmsCode({ phone, purpose: 'signup' });
  service.repository.markSmsVerified = async () => false;
  await assert.rejects(
    service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' }),
    (error) => error.code === 'INVALID_VERIFICATION_CODE',
  );
});

test('only a configured phone skips duplicate lookup for signup SMS sending and verification in every mode', async () => {
  const phone = '01056539944';
  for (const devMode of [false, true]) {
    const { service, state } = createSignupSmsService(devMode, phone);
    service.config.sms.signupDuplicatePhoneAllowlist = [phone];
    state.existingUser = { id: 1, phone };
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const verified = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });

    assert.equal(service.verifySmsToken(verified.verificationToken, 'signup', phone), devMode ? 0 : 42);
    assert.equal(state.phoneLookups, 0);
    assert.equal(state.providerCalls, 1);
  }
});

test('signup SMS duplicate exception compares complete normalized phone numbers', async () => {
  const service = createDevService({ async findUserByPhone() { return { id: 1 }; } });
  service.config.sms.signupDuplicatePhoneAllowlist = ['01056539944'];
  await service.checkSignupPhoneAvailability('010-5653-9944', { allowConfiguredDuplicatePhone: true });
  await assert.rejects(
    service.checkSignupPhoneAvailability('01056539945', { allowConfiguredDuplicatePhone: true }),
    (error) => error.code === 'PHONE_ALREADY_USED',
  );
});

test('an absent, empty or nonmatching SMS allowlist keeps duplicate checks strict in every mode', async () => {
  const phone = '01012345678';
  for (const devMode of [false, true]) {
    for (const allowlist of [undefined, [], ['01056539944']]) {
      const { service, state } = createSignupSmsService(devMode, phone);
      service.config.sms.signupDuplicatePhoneAllowlist = allowlist;
      state.existingUser = { id: 1, phone };
      for (const method of ['sendSmsCode', 'verifySmsCode']) {
        await assert.rejects(
          service[method]({ code: '123456', phone, purpose: 'signup' }),
          (error) => error.code === 'PHONE_ALREADY_USED',
        );
      }
      assert.equal(state.phoneLookups, 2);
      assert.equal(state.providerCalls, 0);
    }
  }
});

test('the signup SMS duplicate exception does not bypass OTP attempt limits or expiry', async () => {
  const phone = '01056539944';
  for (const devMode of [false, true]) {
    const { service, state } = createSignupSmsService(devMode, phone);
    service.config.sms.signupDuplicatePhoneAllowlist = [phone];
    state.existingUser = { id: 1, phone };
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const incorrectCode = state.sentCode === '999999' ? '000000' : '999999';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        service.verifySmsCode({ code: incorrectCode, phone, purpose: 'signup' }),
        (error) => error.code === 'INVALID_VERIFICATION_CODE',
      );
    }
    await assert.rejects(
      service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' }),
      (error) => error.code === 'INVALID_VERIFICATION_CODE',
    );

    await service.sendSmsCode({ phone, purpose: 'signup' });
    if (devMode) service.devSmsVerifications.get(`signup:${phone}`).expiresAt = Date.now() - 1;
    else state.verification.expires_at = new Date(Date.now() - 1);
    await assert.rejects(
      service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' }),
      (error) => error.code === 'INVALID_VERIFICATION_CODE',
    );
    assert.equal(state.phoneLookups, 0);
  }
});

test('the signup SMS duplicate exception keeps real provider rate limits', async () => {
  const phone = '01056539944';
  const { service, state } = createSignupSmsService(false, phone);
  service.config.sms.signupDuplicatePhoneAllowlist = [phone];
  state.existingUser = { id: 1, phone };
  state.recentSmsCount = 3;
  await assert.rejects(
    service.sendSmsCode({ phone, purpose: 'signup' }),
    (error) => error.code === 'SMS_RATE_LIMITED',
  );
  assert.equal(state.phoneLookups, 0);
  assert.equal(state.providerCalls, 0);
  assert.equal(state.verification, null);
});

test('a verified configured phone can complete business preflight but cannot create a duplicate account', async () => {
  const phone = '01056539944';
  for (const devMode of [false, true]) {
    const { service, state } = createSignupSmsService(devMode, phone);
    service.config.sms.signupDuplicatePhoneAllowlist = [phone];
    state.existingUser = { id: 1, phone };
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const verified = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
    const input = { phone, smsVerificationToken: verified.verificationToken, email: 'member@example.com' };
    assert.deepEqual(await service.checkSignupBusiness(input), { available: true });
    assert.equal(state.phoneLookups, 0);
    for (const method of ['checkSignupAvailability', 'signup']) {
      await assert.rejects(service[method](input), (error) => error.code === 'PHONE_ALREADY_USED');
    }
    assert.equal(state.phoneLookups, 2);
  }
});

test('business preflight keeps email uniqueness for a verified configured phone in every mode', async () => {
  const phone = '01056539944';
  for (const devMode of [false, true]) {
    const { service, state } = createSignupSmsService(devMode, phone);
    service.config.sms.signupDuplicatePhoneAllowlist = [phone];
    state.existingUser = { id: 1, phone };
    state.existingEmailUser = { id: 2, email: 'member@example.com' };
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const verified = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
    await assert.rejects(
      service.checkSignupBusiness({ phone, smsVerificationToken: verified.verificationToken, email: 'member@example.com' }),
      (error) => error.code === 'EMAIL_ALREADY_USED',
    );
    assert.equal(state.phoneLookups, 0);
  }
});

test('business preflight still rejects another registered phone when an exception is configured', async () => {
  for (const devMode of [false, true]) {
    const phone = '01012345678';
    const { service, state } = createSignupSmsService(devMode, phone);
    service.config.sms.signupDuplicatePhoneAllowlist = ['01056539944'];
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const verified = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
    state.existingUser = { id: 1, phone };
    await assert.rejects(
      service.checkSignupBusiness({ phone, smsVerificationToken: verified.verificationToken, email: 'member@example.com' }),
      (error) => error.code === 'PHONE_ALREADY_USED',
    );
    assert.equal(state.phoneLookups, 3);
  }
});

const signupBusinessInput = (service, changes = {}) => ({
  companyName: '싸인짱건설',
  email: 'member@example.com',
  phone: '01012345678',
  smsVerificationToken: service.createSmsVerificationToken({
    phone: '01012345678', purpose: 'signup', verificationId: 'dev',
  }),
  ...changes,
});

test('signup business preflight checks duplicates without creating an account', async () => {
  const lookups = [];
  const service = createDevService({
    async findUserByPhone(phone, options) { lookups.push({ phone, options }); return null; },
    async findUserByEmail(email) { lookups.push({ email }); return null; },
  });
  assert.deepEqual(await service.checkSignupBusiness(signupBusinessInput(service)), { available: true });
  assert.deepEqual(lookups, [
    { phone: '01012345678', options: { includeDeleted: true } }, { email: 'member@example.com' },
  ]);
});

test('signup preflight and completion reject a reserved email or phone', async () => {
  for (const duplicateField of ['phone', 'email']) {
    const service = createDevService({
      async findUserByPhone() { return duplicateField === 'phone' ? { id: 1 } : null; },
      async findUserByEmail() { return duplicateField === 'email' ? { id: 2 } : null; },
    });
    const expectedCode = duplicateField === 'phone' ? 'PHONE_ALREADY_USED' : 'EMAIL_ALREADY_USED';
    for (const method of ['checkSignupBusiness', 'signup']) {
      await assert.rejects(service[method](signupBusinessInput(service)), (error) => error.code === expectedCode);
    }
  }
});

test('signup preflight requires a valid signup verification for the same phone before database access', async () => {
  const service = createDevService();
  service.config.sms.signupDuplicatePhoneAllowlist = ['01012345678'];
  for (const token of [
    'invalid-token',
    service.createSmsVerificationToken({ phone: '01099999999', purpose: 'signup', verificationId: 'dev' }),
    service.createSmsVerificationToken({ phone: '01012345678', purpose: 'password_reset', verificationId: 'dev' }),
    jwt.sign({ type: 'sms_verification', phone: '01012345678', purpose: 'signup', verificationId: 'dev' },
      'test-secret-that-is-long-enough-for-jwt-tests', { expiresIn: '-1s' }),
  ]) {
    await assert.rejects(
      service.checkSignupBusiness(signupBusinessInput(service, { smsVerificationToken: token })),
      (error) => error.code === 'VERIFICATION_EXPIRED',
    );
  }
});

test('signup preflight and completion reject an expired, replaced, unverified or consumed SMS row', async () => {
  for (const verification of [
    null,
    { id: 43, verified_at: new Date(), consumed_at: null },
    { id: 42, verified_at: null, consumed_at: null },
    { id: 42, verified_at: new Date(), consumed_at: new Date() },
  ]) {
    const service = createDevService({
      async findLatestActiveSms(phone, purpose) {
        assert.equal(phone, '01012345678');
        assert.equal(purpose, 'signup');
        return verification;
      },
    });
    service.config.sms.devMode = false;
    service.config.sms.signupDuplicatePhoneAllowlist = ['01012345678'];
    const input = signupBusinessInput(service, {
      smsVerificationToken: service.createSmsVerificationToken({
        phone: '01012345678', purpose: 'signup', verificationId: 42,
      }),
    });
    for (const method of ['checkSignupBusiness', 'signup']) {
      await assert.rejects(service[method](input), (error) => error.code === 'VERIFICATION_EXPIRED');
    }
  }
});

test('signup preflight accepts an active verified SMS row matching its token', async () => {
  const service = createDevService({
    async findLatestActiveSms() { return { id: '42', verified_at: new Date(), consumed_at: null }; },
    async findUserByPhone() { return null; },
    async findUserByEmail() { return null; },
  });
  service.config.sms.devMode = false;
  const input = signupBusinessInput(service, {
    smsVerificationToken: service.createSmsVerificationToken({
      phone: '01012345678', purpose: 'signup', verificationId: 42,
    }),
  });
  assert.deepEqual(await service.checkSignupBusiness(input), { available: true });
});

const createAccountUpdateService = (devMode) => {
  const phone = '01056539944';
  const { service, state } = createSignupSmsService(devMode, phone);
  service.config.signup = { accountUpdatePhoneAllowlist: [phone] };
  state.existingUser = {
    id: 17, phone, status: 'active', deleted_at: null, email: 'member@example.com',
    company_name: '기존 중기', full_name: '기존 이름', referral_code: 'SJ-ORIGINAL', referred_by_user_id: 9,
  };
  state.existingEmailUser = { id: '17', email: 'member@example.com' };
  state.updates = [];
  service.repository.createUserWithVerification = async () => assert.fail('Existing account must keep its original ID');
  service.repository.findUserByReferralCode = async () => assert.fail('Account updates must preserve existing referral relationships');
  service.repository.updateUserWithVerification = async (input) => {
    state.updates.push(structuredClone(input));
    assert.equal(String(input.userId), '17');
    assert.equal(input.verificationId, devMode ? 0 : 42);
    if (!devMode) {
      assert.ok(state.verification.verified_at);
      assert.equal(state.verification.consumed_at, null);
      state.verification.consumed_at = new Date();
    }
    Object.assign(state.existingUser, {
      company_name: input.companyName, full_name: input.fullName, email: input.email,
      password_hash: input.passwordHash,
    });
    return state.existingUser.id;
  };
  const verifiedInput = async () => {
    await service.sendSmsCode({ phone, purpose: 'signup' });
    const { verificationToken } = await service.verifySmsCode({ code: state.sentCode, phone, purpose: 'signup' });
    return {
      phone, smsVerificationToken: verificationToken, password: 'UpdatedPass1!',
      companyName: '새로운 중기', fullName: '새 이름', email: 'member@example.com',
      equipments: [{ category: '스카이', tonnage: '3.5톤' }], gender: 'male', birthYear: 1990, marketingAgreed: false,
    };
  };
  return { service, state, phone, verifiedInput };
};

test('the separate account-update allowlist enables verified SMS and same-account email preflight', async () => {
  const { service, state, verifiedInput } = createAccountUpdateService(false);
  assert.equal(service.config.sms.signupDuplicatePhoneAllowlist, undefined);
  const input = await verifiedInput();
  assert.equal(state.providerCalls, 1);
  assert.deepEqual(await service.checkSignupBusiness(input), { available: true });
  assert.equal(state.updates.length, 0);
});

test('allowlisted existing-account signup without a referral updates the same ID and hashes the new password', async () => {
  const { service, state, verifiedInput } = createAccountUpdateService(false);
  const input = await verifiedInput();
  const result = await service.signup(input);
  assert.equal(result.accountUpdated, true);
  assert.equal(result.user.id, '17');
  assert.equal(result.user.fullName, '새 이름');
  assert.equal(result.user.companyName, '새로운 중기');
  assert.equal(result.user.referralCode, 'SJ-ORIGINAL');
  assert.equal(jwt.decode(result.accessToken).sub, '17');
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.updates[0].equipments, input.equipments);
  assert.notEqual(state.updates[0].passwordHash, input.password);
  assert.equal(await bcrypt.compare(input.password, state.updates[0].passwordHash), true);
  assert.equal(Object.hasOwn(state.updates[0], 'referralCode'), false);
  assert.equal(Object.hasOwn(state.updates[0], 'referredByUserId'), false);
  assert.equal(state.existingUser.referred_by_user_id, 9);
});

test('an existing-account update preserves referral relationships even if a different referral was entered', async () => {
  const { service, state, verifiedInput } = createAccountUpdateService(false);
  const input = await verifiedInput();
  const result = await service.signup({ ...input, referralCode: 'NOT-A-REAL-CODE' });
  assert.equal(result.accountUpdated, true);
  assert.equal(result.user.referralCode, 'SJ-ORIGINAL');
  assert.equal(state.existingUser.referred_by_user_id, 9);
  assert.equal(state.updates.length, 1);
});

test('account-update permission never allows an email owned by another account', async () => {
  const { service, state, verifiedInput } = createAccountUpdateService(false);
  const input = await verifiedInput();
  state.existingEmailUser = { id: 18, email: input.email };
  for (const method of ['checkSignupBusiness', 'signup']) {
    await assert.rejects(service[method](input), (error) => error.code === 'EMAIL_ALREADY_USED');
  }
  assert.equal(state.updates.length, 0);
});

test('development-mode proof cannot update an existing account even when its phone is allowlisted', async () => {
  const { service, state, verifiedInput } = createAccountUpdateService(true);
  const input = await verifiedInput();
  for (const method of ['checkSignupBusiness', 'signup']) {
    await assert.rejects(service[method](input), (error) => error.code === 'VERIFICATION_EXPIRED');
  }
  assert.equal(state.updates.length, 0);
});

test('account updates require a current signup proof for the exact phone and consume it only once', async () => {
  const { service, state, phone, verifiedInput } = createAccountUpdateService(false);
  const input = await verifiedInput();
  for (const token of [
    'invalid-token',
    service.createSmsVerificationToken({ phone: '01099999999', purpose: 'signup', verificationId: 42 }),
    service.createSmsVerificationToken({ phone, purpose: 'password_reset', verificationId: 42 }),
    jwt.sign({ type: 'sms_verification', phone, purpose: 'signup', verificationId: '42' },
      service.config.jwt.secret, { expiresIn: '-1s' }),
  ]) {
    await assert.rejects(service.signup({ ...input, smsVerificationToken: token }), (error) => error.code === 'VERIFICATION_EXPIRED');
  }
  assert.equal(state.updates.length, 0);
  await service.signup(input);
  await assert.rejects(service.signup(input), (error) => error.code === 'VERIFICATION_EXPIRED');
  assert.equal(state.updates.length, 1);
});

test('account-update permission cannot update inactive or deleted accounts', async () => {
  for (const changes of [{ status: 'inactive' }, { status: 'withdrawn' }, { deleted_at: new Date() }]) {
    const { service, state, verifiedInput } = createAccountUpdateService(false);
    const input = await verifiedInput();
    Object.assign(state.existingUser, changes);
    for (const method of ['checkSignupBusiness', 'signup']) {
      await assert.rejects(service[method](input), (error) => error.code === 'ACCOUNT_UPDATE_UNAVAILABLE');
    }
    assert.equal(state.updates.length, 0);
  }
});

test('missing, empty or nonmatching account-update permission retains final duplicate-account protection', async () => {
  for (const allowlist of [undefined, [], ['01056539945']]) {
    const { service, state, phone, verifiedInput } = createAccountUpdateService(false);
    const input = await verifiedInput();
    service.config.signup.accountUpdatePhoneAllowlist = allowlist;
    service.config.sms.signupDuplicatePhoneAllowlist = [phone];
    await assert.rejects(service.signup(input), (error) => error.code === 'PHONE_ALREADY_USED');
    assert.equal(state.updates.length, 0);
  }
});
