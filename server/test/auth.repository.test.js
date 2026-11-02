const assert = require('node:assert/strict');
const { test } = require('node:test');

const { AuthRepository } = require('../src/repositories/auth.repository');

test('signup availability includes deleted accounts whose phone and email remain reserved', async () => {
  const queries = [];
  const repository = new AuthRepository({
    async execute(query, values) { queries.push({ query, values }); return [[{ id: 7 }]]; },
  });

  await repository.findUserByPhone('01012345678');
  await repository.findUserByPhone('01012345678', { includeDeleted: true });
  await repository.findUserByEmail('member@example.com');

  assert.match(queries[0].query, /deleted_at IS NULL/);
  assert.doesNotMatch(queries[1].query, /deleted_at IS NULL/);
  assert.doesNotMatch(queries[2].query, /deleted_at IS NULL/);
  assert.deepEqual(queries.map(({ values }) => values), [
    ['01012345678'], ['01012345678'], ['member@example.com'],
  ]);
});

test('SMS verification stores the exact proof deadline only for a live unused OTP below the attempt limit', async () => {
  const expiresAt = new Date('2026-11-01T10:30:00.000Z');
  for (const affectedRows of [1, 0]) {
    const repository = new AuthRepository({
      async execute(query, values) {
        assert.match(query, /SET verified_at = NOW\(3\), expires_at = \?/);
        assert.match(query, /verified_at IS NULL/);
        assert.match(query, /consumed_at IS NULL/);
        assert.match(query, /expires_at > NOW\(3\)/);
        assert.match(query, /attempts < 5/);
        assert.deepEqual(values, [expiresAt, 42]);
        return [{ affectedRows }];
      },
    });
    assert.equal(await repository.markSmsVerified(42, expiresAt), affectedRows === 1);
  }
});

const signupInput = (equipments) => ({
  phone: '01012345678', passwordHash: 'test-password-hash', companyName: '테스트 장비회사', fullName: '테스트 기사',
  gender: 'other', birthYear: null, email: 'member@example.com', marketingAgreed: false,
  referralCode: 'SJ-TEST', referredByUserId: null, verificationId: 42, equipments,
});

const createSignupRepository = (failSpecification) => {
  const state = { calls: [], equipmentRows: [], committed: false, rolledBack: false, released: false };
  const connection = {
    async beginTransaction() { state.calls.push('begin'); },
    async execute(query, values) {
      if (query.includes('UPDATE sms_verifications')) {
        state.calls.push('verify');
        return [{ affectedRows: 1 }];
      }
      if (query.includes('INSERT INTO users')) {
        state.calls.push('user');
        return [{ insertId: 7 }];
      }
      assert.match(query, /INSERT INTO user_equipments/);
      assert.match(query, /VALUES \(\?, \?, \?\)/);
      state.calls.push('equipment');
      if (values[2] === failSpecification) throw new Error('equipment insert failed');
      state.equipmentRows.push(values);
      return [{ insertId: state.equipmentRows.length }];
    },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() { state.released = true; },
  };
  return { repository: new AuthRepository({ async getConnection() { return connection; } }), state };
};

test('signup saves separate equipment specifications and retains null specifications for legacy categories', async () => {
  const { repository, state } = createSignupRepository();
  const userId = await repository.createUserWithVerification(signupInput([
    { category: '지게차', tonnage: '1톤' }, { category: '지게차', tonnage: '2톤' }, '스카이',
  ]));

  assert.equal(userId, 7);
  assert.deepEqual(state.equipmentRows, [[7, '지게차', '1톤'], [7, '지게차', '2톤'], [7, '스카이', null]]);
  assert.deepEqual(state.calls, ['begin', 'verify', 'user', 'equipment', 'equipment', 'equipment']);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.released, true);
});

test('signup rolls back the account and verification transaction when saving equipment details fails', async () => {
  const { repository, state } = createSignupRepository('2톤');
  await assert.rejects(
    repository.createUserWithVerification(signupInput([
      { category: '지게차', tonnage: '1톤' }, { category: '지게차', tonnage: '2톤' },
    ])),
    /equipment insert failed/,
  );
  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
});

const accountUpdateInput = (equipments = [{ category: '지게차', tonnage: '2톤' }]) => ({
  ...signupInput(equipments), userId: 7, passwordHash: 'new-password-hash', companyName: '새 상호',
  fullName: '새 이름', gender: 'female', birthYear: 1991, email: 'updated@example.com', marketingAgreed: true,
});

const createAccountUpdateRepository = ({ status = 'active', deletedAt = null, proof = {}, failAt } = {}) => {
  const state = {
    commits: 0, rollbacks: 0, releases: 0, calls: [],
    database: {
      user: {
        id: 7, phone: '01012345678', status, deleted_at: deletedAt, password_hash: 'old-hash', company_name: '기존 상호',
        full_name: '기존 이름', gender: 'male', birth_year: 1990, email: 'member@example.com', marketing_agreed: 0,
        bank_name: '은행', bank_account: 'saved-account', bank_holder: '기존 이름', business_registration_no: 'saved-business',
        referral_code: 'SJ-KEEP', referred_by_user_id: 9, profile_image_url: '/uploads/keep-profile.png',
      },
      verification: {
        id: 42, phone: '01012345678', purpose: 'signup', verified_at: new Date(),
        consumed_at: null, expires_at: new Date(Date.now() + 1_800_000), ...proof,
      },
      equipments: [
        { id: 11, user_id: 7, category: '지게차', specification: '1톤', vehicle_no: '기존차번', image_key: 'keep-photo' },
        { id: 12, user_id: 7, category: '크레인', specification: '5톤', vehicle_no: '미선택차번', image_key: 'keep-unselected-photo' },
        { id: 13, user_id: 7, category: '스카이', specification: '', vehicle_no: 'legacy-empty', image_key: null },
        { id: 14, user_id: 7, category: '사다리차', specification: null, vehicle_no: 'legacy-null', image_key: null },
      ],
      contracts: [{ id: 31, user_id: 7 }], schedules: [{ id: 32, user_id: 7 }], documents: [{ id: 33, user_id: 7 }],
    },
  };
  let snapshot;
  const connection = {
    async beginTransaction() { snapshot = structuredClone(state.database); state.calls.push('begin'); },
    async execute(query, values) {
      if (query.includes('SELECT id FROM users')) {
        assert.match(query, /id = \? AND phone = \? AND status = 'active' AND deleted_at IS NULL\s+FOR UPDATE/);
        state.calls.push('lock-user');
        const user = state.database.user;
        return [[user].filter((item) => item.id === values[0] && item.phone === values[1] && item.status === 'active' && !item.deleted_at)];
      }
      if (query.includes('UPDATE sms_verifications')) {
        assert.match(query, /purpose = 'signup'/);
        assert.match(query, /verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW\(3\)/);
        state.calls.push('consume-proof');
        const verification = state.database.verification;
        if (verification.id !== values[0] || verification.phone !== values[1] || verification.purpose !== 'signup'
          || !verification.verified_at || verification.consumed_at || verification.expires_at.getTime() <= Date.now()) {
          return [{ affectedRows: 0 }];
        }
        verification.consumed_at = new Date();
        return [{ affectedRows: 1 }];
      }
      if (query.includes('UPDATE users')) {
        state.calls.push('update-user');
        const assignments = query.split('WHERE')[0];
        assert.doesNotMatch(assignments, /bank_|referral_|profile_image_url|business_registration_no|\bphone\s*=|\bid\s*=|\bstatus\s*=/);
        if (failAt === 'email') throw Object.assign(new Error('duplicate email'), { code: 'ER_DUP_ENTRY' });
        const [password_hash, company_name, full_name, gender, birth_year, email, marketing_agreed, id, phone] = values;
        assert.equal(id, 7);
        assert.equal(phone, state.database.user.phone);
        Object.assign(state.database.user, { password_hash, company_name, full_name, gender, birth_year, email, marketing_agreed });
        return [{ affectedRows: 1 }];
      }
      if (query.includes('SELECT id FROM user_equipments')) {
        state.calls.push('find-equipment');
        assert.match(query, /NULLIF\(TRIM\(specification\), ''\) <=> \?/);
        assert.match(query, /FOR UPDATE/);
        return [state.database.equipments.filter((equipment) => equipment.user_id === values[0]
          && equipment.category === values[1] && (equipment.specification?.trim() || null) === values[2])];
      }
      if (query.includes('INSERT INTO user_equipments')) {
        state.calls.push('add-equipment');
        if (failAt === 'equipment') throw new Error('equipment insert failed');
        const [user_id, category, specification] = values;
        state.database.equipments.push({ id: 15 + state.database.equipments.length, user_id, category, specification, vehicle_no: null, image_key: null });
        return [{ affectedRows: 1 }];
      }
      assert.fail(`Unexpected mutation: ${query}`);
    },
    async commit() { state.commits += 1; },
    async rollback() { state.database = snapshot; state.rollbacks += 1; },
    release() { state.releases += 1; },
  };
  return { repository: new AuthRepository({ async getConnection() { return connection; } }), state };
};

test('existing-account signup update preserves records and equipment metadata while applying approved fields', async () => {
  const { repository, state } = createAccountUpdateRepository();
  const before = structuredClone(state.database);
  const input = accountUpdateInput([
    { category: '지게차', tonnage: '1톤' }, { category: '지게차', tonnage: '2톤' },
    { category: '지게차', tonnage: '2톤' }, '스카이', '사다리차',
  ]);
  assert.equal(await repository.updateUserWithVerification(input), 7);
  assert.deepEqual(state.database.user, {
    ...before.user, password_hash: input.passwordHash, company_name: input.companyName, full_name: input.fullName,
    gender: input.gender, birth_year: input.birthYear, email: input.email, marketing_agreed: 1,
  });
  assert.deepEqual(state.database.equipments.slice(0, 4), before.equipments);
  assert.equal(state.database.equipments.length, 5);
  assert.equal(state.database.equipments[4].specification, '2톤');
  for (const table of ['contracts', 'schedules', 'documents']) assert.deepEqual(state.database[table], before[table]);
  assert.ok(state.database.verification.consumed_at);
  assert.deepEqual(state.calls.slice(0, 4), ['begin', 'lock-user', 'consume-proof', 'update-user']);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 0);
  assert.equal(state.releases, 1);

  await assert.rejects(repository.updateUserWithVerification(input), (error) => error.code === 'VERIFICATION_EXPIRED');
  assert.equal(state.commits, 1);
  assert.equal(state.releases, 2);
});

test('existing-account update rejects inactive or deleted accounts before consuming SMS proof', async () => {
  for (const options of [{ status: 'inactive' }, { status: 'withdrawn' }, { deletedAt: new Date() }]) {
    const { repository, state } = createAccountUpdateRepository(options);
    const before = structuredClone(state.database);
    await assert.rejects(repository.updateUserWithVerification(accountUpdateInput()), (error) => error.code === 'ACCOUNT_UPDATE_UNAVAILABLE');
    assert.deepEqual(state.database, before);
    assert.deepEqual(state.calls, ['begin', 'lock-user']);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.releases, 1);
  }
});

test('existing-account update cannot target a different user ID or phone', async () => {
  for (const changes of [{ userId: 8 }, { phone: '01099999999' }]) {
    const { repository, state } = createAccountUpdateRepository();
    const before = structuredClone(state.database);
    await assert.rejects(
      repository.updateUserWithVerification({ ...accountUpdateInput(), ...changes }),
      (error) => error.code === 'ACCOUNT_UPDATE_UNAVAILABLE',
    );
    assert.deepEqual(state.database, before);
    assert.deepEqual(state.calls, ['begin', 'lock-user']);
    assert.equal(state.releases, 1);
  }
});

test('existing-account update requires a real unused verified live signup proof for that phone', async () => {
  for (const proof of [
    { verified_at: null }, { consumed_at: new Date() }, { expires_at: new Date(Date.now() - 1) },
    { purpose: 'password_reset' }, { phone: '01099999999' },
  ]) {
    const { repository, state } = createAccountUpdateRepository({ proof });
    const before = structuredClone(state.database);
    await assert.rejects(repository.updateUserWithVerification(accountUpdateInput()), (error) => error.code === 'VERIFICATION_EXPIRED');
    assert.deepEqual(state.database, before);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.releases, 1);
  }
  const { repository, state } = createAccountUpdateRepository();
  await assert.rejects(repository.updateUserWithVerification({ ...accountUpdateInput(), verificationId: 0 }), (error) => error.code === 'VERIFICATION_EXPIRED');
  assert.deepEqual(state.calls, []);
});

test('email collision or equipment failure rolls back profile password and proof consumption together', async () => {
  for (const failAt of ['email', 'equipment']) {
    const { repository, state } = createAccountUpdateRepository({ failAt });
    const before = structuredClone(state.database);
    await assert.rejects(
      repository.updateUserWithVerification(accountUpdateInput()),
      (error) => failAt === 'email' ? error.code === 'ER_DUP_ENTRY' : error.message === 'equipment insert failed',
    );
    assert.deepEqual(state.database, before);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.releases, 1);
  }
});
