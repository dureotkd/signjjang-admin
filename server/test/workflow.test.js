const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AppRepository } = require('../src/repositories/app.repository');
const { contractWorkDate, koreanToday, scheduleFromContract, statusForDate } = require('../src/workflow');

// A transactional SQL double exercises repository boundaries without writing
// any operator's production contracts, ledger entries, or SMS deliveries.
class LedgerPool {
  constructor() {
    this.contracts = [];
    this.schedules = [];
    this.statements = [];
    this.nextId = 1;
    this.queue = Promise.resolve();
  }

  async getConnection() {
    let releaseLock;
    let snapshot;
    const pool = this;
    return {
      async beginTransaction() {
        const previous = pool.queue;
        pool.queue = new Promise((resolve) => { releaseLock = resolve; });
        await previous;
        snapshot = structuredClone({ contracts: pool.contracts, schedules: pool.schedules });
      },
      async commit() { releaseLock(); },
      async rollback() {
        pool.contracts = snapshot.contracts;
        pool.schedules = snapshot.schedules;
        releaseLock();
      },
      execute: (...args) => pool.execute(...args),
      release() {},
    };
  }

  async execute(sql, parameters = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(query);
    const p = parameters;
    const same = (a, b) => String(a) === String(b);
    const select = (rows) => [structuredClone(rows)];
    const result = (affectedRows = 1) => [{ affectedRows }];
    if (query.startsWith('SELECT') && query.includes('FROM contracts')) {
      return select(this.contracts.filter((row) => same(row.id, p[0]) && same(row.user_id, p[1])));
    }
    if (query.startsWith('SELECT') && query.includes('FROM schedules')) {
      return select(this.schedules.filter((row) => query.includes('WHERE user_id = ? AND contract_id = ?')
        ? same(row.user_id, p[0]) && same(row.contract_id, p[1])
        : same(row.id, p[0]) && same(row.user_id, p[1])));
    }
    if (query.startsWith('INSERT INTO contracts')) {
      const id = this.nextId++;
      this.contracts.push({ id, user_id: p[0], type: p[1], status: p[2], progress: p[3], start_date: p[4],
        fee: p[5], site_latitude: p[6], site_longitude: p[7], payload: p[8], updated_at: new Date() });
      return [{ insertId: id }];
    }
    if (query.startsWith('INSERT INTO schedules')) {
      if (this.failOnScheduleWrite) throw new Error('schedule storage failed');
      const id = this.nextId++;
      this.schedules.push({ id, user_id: p[0], contract_id: p[1], work_date: p[2], status: p[3],
        settlement: p[4], fee: p[5], site_latitude: p[6], site_longitude: p[7], payload: p[8] });
      return [{ insertId: id }];
    }
    if (query.startsWith('UPDATE contracts SET type')) {
      const row = this.contracts.find((item) => same(item.id, p[8]) && same(item.user_id, p[9]));
      if (!row) return result(0);
      Object.assign(row, { type: p[0], status: p[1], progress: p[2], start_date: p[3], fee: p[4],
        site_latitude: p[5], site_longitude: p[6], payload: p[7], updated_at: new Date() });
      return result();
    }
    if (query.startsWith('UPDATE contracts SET progress')) {
      const row = this.contracts.find((item) => same(item.id, p[2]) && same(item.user_id, p[3]));
      if (!row) return result(0);
      row.progress = p[0];
      row.payload = JSON.stringify({ ...JSON.parse(row.payload), progress: p[1] });
      return result();
    }
    if (query.startsWith('UPDATE schedules SET contract_id = NULL')) {
      const rows = this.schedules.filter((row) => same(row.user_id, p[0]) && same(row.contract_id, p[1]));
      rows.forEach((row) => {
        row.contract_id = null;
        const payload = JSON.parse(row.payload);
        delete payload.contractId;
        row.payload = JSON.stringify(payload);
      });
      return result(rows.length);
    }
    if (query.startsWith('UPDATE schedules SET contract_id')) {
      if (this.failOnScheduleWrite) throw new Error('schedule storage failed');
      const row = this.schedules.find((item) => same(item.id, p[8]) && same(item.user_id, p[9]));
      if (!row) return result(0);
      Object.assign(row, { contract_id: p[0], work_date: p[1], status: p[2], settlement: p[3], fee: p[4],
        site_latitude: p[5], site_longitude: p[6], payload: p[7] });
      return result();
    }
    if (query.startsWith('DELETE FROM contracts')) {
      const length = this.contracts.length;
      this.contracts = this.contracts.filter((row) => !same(row.id, p[0]) || !same(row.user_id, p[1]));
      return result(length - this.contracts.length);
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }
}

const example = (overrides = {}) => ({
  endDate: '2099-09-08', equipment: '스카이', fee: 500000, memo: '', orderer: '장비왕',
  orderPhone: '01054893899', progress: 'scheduled', siteAddress: '송화리151-18',
  siteName: '평택 전지작업', sitePhone: '01054893899', startDate: '2099-09-08',
  status: 'completed', tenant: '이엘', type: '건설기계사용확인서', vehicleNo: '경기 01가 1234',
  workContent: '전지작업', usagePeriods: ['하루'], ...overrides,
});

test('saved contracts immediately create one schedule, while drafts wait until saved', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const draft = await repository.createContract(7, example({ status: 'draft' }));
  assert.equal(pool.schedules.length, 0);
  const contract = await repository.createContract(7, example({ status: 'saved' }));
  assert.equal(pool.schedules.length, 1);
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  assert.equal(schedule.contractId, contract.id);
  assert.equal(schedule.fee, 500000);
  assert.equal(schedule.note, '전지작업');
  assert.equal(schedule.orderer, '장비왕');
  assert.equal(schedule.settlement, '미수금');
  assert.equal(schedule.status, 'scheduled');
  await repository.updateContract(7, contract.id, example());
  assert.equal(pool.schedules.length, 1);
  await repository.updateContract(7, draft.id, example({ status: 'saved' }));
  assert.equal(pool.schedules.length, 2);
});

test('old APK retries and simultaneous linked schedule creation cannot duplicate a paid entry', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  await repository.updateSchedule(7, schedule.id, { ...schedule, status: 'settled', settlement: '정산완료' });
  const results = await Promise.all(Array.from({ length: 3 }, () => repository.createSchedule(7, {
    ...schedule, fee: 1, status: 'scheduled', settlement: '미수금',
  })));
  assert.equal(pool.schedules.length, 1);
  for (const entry of results) {
    assert.equal(entry.id, schedule.id);
    assert.equal(entry.fee, 500000);
    assert.equal(entry.settlement, '정산완료');
  }
  assert.equal((await repository.getContract(7, contract.id)).progress, 'scheduled');
  assert.ok(pool.statements.some((query) => query.includes('FROM contracts') && query.endsWith('FOR UPDATE')));
});

test('editing an unpaid contract synchronizes site/date/fee without losing its payment state', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  const updated = await repository.updateContract(7, contract.id, example({
    endDate: '2000-09-08', fee: 600000, siteAddress: '명암동 9-9', siteName: '청주후레싱 시공 현장',
    startDate: '2000-09-08', tenant: '확인된 회사', sitePhone: '', workContent: '후레싱 시공작업',
    usagePeriods: ['하루'], hourWork: '1',
  }));
  const ledger = await repository.getSchedule(7, schedule.id);
  assert.equal(pool.schedules.length, 1);
  assert.equal(ledger.fee, 600000);
  assert.equal(ledger.date, '2000-09-08');
  assert.equal(ledger.siteName, '청주후레싱 시공 현장');
  assert.equal(ledger.hourWork, '1');
  assert.equal(ledger.tenant, '확인된 회사');
  assert.equal(ledger.status, 'ended');
  assert.equal(ledger.settlement, '미수금');
  assert.equal(updated.progress, 'ended');
});

test('paid contracts reject content updates and linked schedule edits without changing saved data', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const other = await repository.createContract(7, example({ status: 'draft' }));
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  const paid = await repository.updateSchedule(7, schedule.id, { ...schedule, status: 'settled' }, { statusOnly: true });
  const before = structuredClone({ contracts: pool.contracts, schedules: pool.schedules });
  const error = { status: 409, code: 'CONTRACT_PAYMENT_COMPLETED', message: '수금완료된 계약서는 수정할 수 없습니다.' };
  await assert.rejects(repository.updateContract(7, contract.id, {
    ...contract, fee: 1, progress: 'unpaid', signatureDone: true, memo: 'blocked',
  }), error);
  for (const contractId of [contract.id, undefined, other.id]) {
    await assert.rejects(repository.updateSchedule(7, schedule.id, {
      ...paid, contractId, fee: 1, date: '2000-01-01', settlement: '미수금',
    }), error);
  }
  assert.deepEqual({ contracts: pool.contracts, schedules: pool.schedules }, before);

  // A payment correction from an old full-payload client remains a state-only
  // action. It cannot smuggle edits or detach the persisted contract link.
  const unpaid = await repository.updateSchedule(7, schedule.id, {
    ...paid, contractId: other.id, fee: 1, date: '2000-01-01', status: 'unpaid', siteName: 'blocked',
  });
  assert.equal(unpaid.contractId, contract.id);
  assert.equal(unpaid.fee, 500000);
  assert.equal(unpaid.date, '2099-09-08');
  assert.equal(unpaid.siteName, contract.siteName);
  assert.equal(unpaid.settlement, '미수금');
  const edited = await repository.updateContract(7, contract.id, { ...contract, fee: 600000 });
  assert.equal(edited.fee, 600000);
});

test('any paid historical linked schedule locks the contract until that payment is corrected', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const original = await repository.getSchedule(7, pool.schedules[0].id);
  const duplicate = structuredClone(pool.schedules[0]);
  duplicate.id = pool.nextId++;
  duplicate.settlement = '정산완료';
  pool.schedules.push(duplicate);
  await assert.rejects(repository.updateContract(7, contract.id, { ...contract, fee: 1 }), { code: 'CONTRACT_PAYMENT_COMPLETED' });
  await assert.rejects(repository.updateSchedule(7, original.id, { ...original, settlement: '미수금' }), { code: 'CONTRACT_PAYMENT_COMPLETED' });
  const recorded = await repository.getSchedule(7, duplicate.id);
  await repository.updateSchedule(7, duplicate.id, { ...recorded, status: 'unpaid' }, { statusOnly: true });
  // Once actual linked records are unpaid, stale legacy contract progress is
  // not allowed to override the authoritative payment ledger.
  pool.contracts[0].progress = 'settled';
  const updated = await repository.updateContract(7, contract.id, { ...contract, fee: 600000 });
  assert.equal(updated.fee, 600000);
});

test('legacy contracts without schedules use their stored paid progress for the edit lock', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example({ status: 'draft', progress: 'settled' }));
  assert.equal(pool.schedules.length, 0);
  await assert.rejects(repository.updateContract(7, contract.id, {
    ...contract, progress: 'scheduled', fee: 1,
  }), { status: 409, code: 'CONTRACT_PAYMENT_COMPLETED' });
  assert.equal((await repository.getContract(7, contract.id)).fee, 500000);
});

test('a payment recorded before a concurrent contract save is checked inside the transaction', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  const [payment, edit] = await Promise.allSettled([
    repository.updateSchedule(7, schedule.id, { ...schedule, status: 'settled' }, { statusOnly: true }),
    repository.updateContract(7, contract.id, { ...contract, fee: 1 }),
  ]);
  assert.equal(payment.status, 'fulfilled');
  assert.equal(edit.status, 'rejected');
  assert.equal(edit.reason.code, 'CONTRACT_PAYMENT_COMPLETED');
  assert.equal((await repository.getContract(7, contract.id)).fee, 500000);
  assert.equal((await repository.getSchedule(7, schedule.id)).settlement, '정산완료');
});

test('the four operator examples accept unknown fields and a past work log without a contract', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  await repository.createContract(7, example());
  await repository.createContract(7, example({ orderer: '용 스카이', fee: 300000,
    siteName: '아산 유리시공 현장', tenant: '금강아이엔피', siteAddress: '가산리483-1',
    workContent: '유리시공작업', usagePeriods: ['반나절'] }));
  await repository.createContract(7, example({ orderer: '강변지게차', fee: 600000,
    siteName: '청주후레싱 시공 현장', tenant: '', sitePhone: '', siteAddress: '명암동 9-9',
    workContent: '후레싱 시공작업', usagePeriods: ['하루'], hourWork: '1' }));
  const log = await repository.createSchedule(7, {
    date: '2000-09-05', equipment: '스카이', fee: 300000, note: 'cctv시공',
    orderer: '구름스카이', orderPhone: '01054893899', settlement: '미수금',
    siteAddress: '원남리1196-1', siteName: '논산cctv현장', sitePhone: '01054893899',
    status: 'scheduled', tenant: 'km모빌', vehicleNo: '경기 01가 1234', weather: '',
    workContent: 'cctv시공', usageHours: '2',
  });
  assert.equal(pool.contracts.length, 3);
  assert.equal(pool.schedules.length, 4);
  assert.equal(pool.schedules.reduce((sum, item) => sum + Number(item.fee), 0), 1700000);
  assert.equal(log.contractId, undefined);
  assert.equal(log.status, 'ended');
  assert.equal(log.settlement, '미수금');
  assert.equal(log.usageHours, '2');
});

test('a schedule storage failure rolls back both contract creation and later contract edits', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  pool.failOnScheduleWrite = true;
  await assert.rejects(repository.createContract(7, example()), /schedule storage failed/);
  assert.equal(pool.contracts.length, 0);
  assert.equal(pool.schedules.length, 0);
  pool.failOnScheduleWrite = false;
  const contract = await repository.createContract(7, example());
  pool.failOnScheduleWrite = true;
  await assert.rejects(repository.updateContract(7, contract.id, example({ fee: 900000 })), /schedule storage failed/);
  assert.equal((await repository.getContract(7, contract.id)).fee, 500000);
  assert.equal(pool.schedules[0].fee, 500000);
});

test('deleting a document detaches, but never deletes, the driver work and payment ledger', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  await repository.deleteContract(7, contract.id);
  assert.equal(pool.contracts.length, 0);
  assert.equal(pool.schedules.length, 1);
  const log = await repository.getSchedule(7, pool.schedules[0].id);
  assert.equal(log.contractId, undefined);
  assert.equal(log.fee, 500000);
  assert.equal(log.orderer, '장비왕');
  assert.equal(Object.hasOwn(JSON.parse(pool.schedules[0].payload), 'contractId'), false);
});

test('another user cannot link a schedule to a private contract', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  await assert.rejects(repository.createSchedule(8, { contractId: contract.id }), { code: 'CONTRACT_NOT_FOUND' });
  assert.equal(pool.schedules.length, 1);
});

test('a historical duplicate schedule can still record and undo its payment', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  await repository.createContract(7, example());
  // Simulate a duplicate made by an older server, without making a new one
  // through the now-idempotent createSchedule API.
  const duplicate = structuredClone(pool.schedules[0]);
  duplicate.id = pool.nextId++;
  pool.schedules.push(duplicate);
  const existing = await repository.getSchedule(7, duplicate.id);
  const paid = await repository.updateSchedule(7, duplicate.id, {
    ...existing, status: 'settled', settlement: '정산완료',
  });
  assert.equal(paid.id, String(duplicate.id));
  assert.equal(paid.settlement, '정산완료');
  const unpaid = await repository.updateSchedule(7, duplicate.id, {
    ...paid, status: 'unpaid', settlement: '미수금',
  });
  assert.equal(unpaid.status, 'scheduled');
  assert.equal(unpaid.settlement, '미수금');
  assert.equal(pool.schedules.length, 2);
});

test('collecting payment from a stale screen preserves the latest locked contract fields', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const stale = await repository.getSchedule(7, pool.schedules[0].id);
  await repository.updateContract(7, contract.id, example({
    fee: 600000, startDate: '2099-09-11', endDate: '2099-09-11', siteName: '청주후레싱 시공 현장',
    siteAddress: '명암동 9-9', tenant: '현장에서 확인한 회사', workContent: '후레싱 시공작업',
    siteLatitude: 36.641, siteLongitude: 127.501,
  }));
  const paid = await repository.updateSchedule(7, stale.id, {
    ...stale, status: 'settled', settlement: '정산완료',
  });
  assert.equal(paid.fee, 600000);
  assert.equal(paid.date, '2099-09-11');
  assert.equal(paid.siteName, '청주후레싱 시공 현장');
  assert.equal(paid.siteAddress, '명암동 9-9');
  assert.equal(paid.tenant, '현장에서 확인한 회사');
  assert.equal(paid.note, '후레싱 시공작업');
  assert.equal(paid.siteLatitude, 36.641);
  assert.equal(paid.settlement, '정산완료');
  assert.equal((await repository.getContract(7, contract.id)).progress, 'scheduled');
});

test('a stale work-status update does not clear payment, but explicit unpaid does', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  await repository.createContract(7, example());
  const stale = await repository.getSchedule(7, pool.schedules[0].id);
  await repository.updateSchedule(7, stale.id, { ...stale, status: 'settled', settlement: '정산완료' });
  const ended = await repository.updateSchedule(7, stale.id, { ...stale, status: 'ended' }, { statusOnly: true });
  assert.equal(ended.settlement, '정산완료');
  const unpaid = await repository.updateSchedule(7, stale.id, { ...ended, status: 'unpaid' });
  assert.equal(unpaid.settlement, '미수금');
});

test('a new competing contract link is rejected even while historical duplicates remain editable', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example());
  const standalone = await repository.createSchedule(7, {
    date: '2000-09-05', fee: 300000, status: 'ended', settlement: '미수금',
  });
  await assert.rejects(repository.updateSchedule(7, standalone.id, {
    ...standalone, contractId: contract.id,
  }), { code: 'CONTRACT_SCHEDULE_EXISTS' });
  assert.equal((await repository.getSchedule(7, standalone.id)).contractId, undefined);
});

test('calendar defaults use Korea time and expire unfinished work while preserving completion', () => {
  assert.equal(koreanToday(new Date('2026-09-07T15:01:00Z')), '2026-09-08');
  assert.equal(statusForDate('scheduled', '2026-09-05', '2026-09-08'), 'ended');
  assert.equal(statusForDate('scheduled', '2026-09-11', '2026-09-08'), 'scheduled');
  assert.equal(statusForDate('inProgress', '2026-09-05', '2026-09-08'), 'ended');
  for (const status of ['ended', 'unpaid', 'settled']) {
    assert.equal(statusForDate(status, '2026-09-05', '2026-09-08'), status);
  }
  assert.equal(scheduleFromContract(example({ id: '1', startDate: '2026-09-11' }), {
    date: '2026-09-05', status: 'ended', settlement: '미수금',
  }, '2026-09-08').status, 'ended');
  assert.equal(scheduleFromContract(example({ id: '1', startDate: '2026-09-11' }), {
    date: '2026-09-05', status: 'unpaid', settlement: '미수금',
  }, '2026-09-08').status, 'unpaid');
});

test('an advance payment does not turn a future reservation into completed work', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const prepaid = await repository.createSchedule(7, {
    date: '2099-09-11', fee: 600000, status: 'scheduled', settlement: '정산완료',
  });
  assert.equal(prepaid.status, 'scheduled');
  assert.equal(prepaid.settlement, '정산완료');
  const edited = await repository.updateSchedule(7, prepaid.id, { ...prepaid, fee: 700000 });
  assert.equal(edited.status, 'scheduled');
  assert.equal(edited.settlement, '정산완료');

  const contract = await repository.createContract(7, example());
  const linkedRow = pool.schedules.find((row) => String(row.contract_id) === contract.id);
  linkedRow.settlement = '정산완료';
  await assert.rejects(repository.updateContract(7, contract.id, example({ fee: 600000 })), {
    status: 409, code: 'CONTRACT_PAYMENT_COMPLETED',
  });
  const linked = await repository.getSchedule(7, linkedRow.id);
  assert.equal(linked.status, 'scheduled');
  assert.equal(linked.settlement, '정산완료');
  assert.equal(linked.fee, 500000);
  assert.equal((await repository.getContract(7, contract.id)).progress, 'scheduled');
});

test('explicit completion persists independently of payment and later contract date edits', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example({ status: 'saved' }));
  const scheduled = await repository.getSchedule(7, pool.schedules[0].id);
  const prepaid = await repository.updateSchedule(7, scheduled.id, {
    ...scheduled, status: 'settled', settlement: '정산완료',
  });
  assert.equal(prepaid.status, 'scheduled');
  const completed = await repository.updateSchedule(7, scheduled.id, { ...scheduled, status: 'ended' }, { statusOnly: true });
  assert.equal(completed.status, 'ended');
  assert.equal(completed.settlement, '정산완료');
  const unpaid = await repository.updateSchedule(7, scheduled.id, { ...scheduled, status: 'unpaid' });
  assert.equal(unpaid.status, 'ended');
  assert.equal(unpaid.settlement, '미수금');
  const edited = await repository.updateContract(7, contract.id, example({
    startDate: '2099-10-12', endDate: '2099-10-12', fee: 700000,
  }));
  assert.equal(edited.progress, 'ended');
  const persisted = await repository.getSchedule(7, scheduled.id);
  assert.equal(persisted.status, 'ended');
  assert.equal(persisted.date, '2099-10-12');
  assert.equal(persisted.settlement, '미수금');
  assert.equal(pool.schedules.length, 1);
});

test('standalone work completion and payment corrections preserve independent states', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const scheduled = await repository.createSchedule(7, {
    date: koreanToday(), fee: 300000, status: 'scheduled', settlement: '미수금',
  });
  const prepaid = await repository.updateSchedule(7, scheduled.id, { ...scheduled, status: 'settled' });
  assert.equal(prepaid.status, 'scheduled');
  assert.equal(prepaid.settlement, '정산완료');
  const completed = await repository.updateSchedule(7, scheduled.id, { ...scheduled, status: 'ended' }, { statusOnly: true });
  assert.equal(completed.settlement, '정산완료');
  const unpaid = await repository.updateSchedule(7, scheduled.id, { ...scheduled, status: 'unpaid' });
  assert.equal(unpaid.status, 'ended');
  assert.equal(unpaid.settlement, '미수금');
});

test('a collection correction keeps legacy completed work completed', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const legacy = await repository.createSchedule(7, {
    date: '2099-09-11', fee: 600000, status: 'settled', settlement: '정산완료',
  });
  const corrected = await repository.updateSchedule(7, legacy.id, { ...legacy, status: 'unpaid' });
  assert.equal(corrected.status, 'ended');
  assert.equal(corrected.settlement, '미수금');
});

test('a full schedule edit saves work completion and collection together', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const standalone = await repository.createSchedule(7, {
    date: '2099-09-11', fee: 600000, status: 'scheduled', settlement: '미수금',
  });
  const completed = await repository.updateSchedule(7, standalone.id, {
    ...standalone, status: 'ended', settlement: '정산완료', fee: 700000,
  });
  assert.equal(completed.status, 'ended');
  assert.equal(completed.settlement, '정산완료');
  assert.equal(completed.fee, 700000);

  await repository.createContract(7, example());
  const linked = await repository.getSchedule(7, pool.schedules[1].id);
  const linkedCompleted = await repository.updateSchedule(7, linked.id, {
    ...linked, status: 'ended', settlement: '정산완료', fee: 1,
  });
  assert.equal(linkedCompleted.status, 'ended');
  assert.equal(linkedCompleted.settlement, '정산완료');
  assert.equal(linkedCompleted.fee, 500000);
});

test('a standalone status-only action preserves newer saved details and collection', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const stale = await repository.createSchedule(7, {
    date: '2099-09-11', fee: 600000, status: 'scheduled', settlement: '미수금', siteAddress: '첫 주소',
  });
  await repository.updateSchedule(7, stale.id, {
    ...stale, date: '2099-09-12', fee: 700000, settlement: '정산완료', siteAddress: '변경 주소',
  });
  const completed = await repository.updateSchedule(7, stale.id, { ...stale, status: 'ended' }, { statusOnly: true });
  assert.equal(completed.status, 'ended');
  assert.equal(completed.settlement, '정산완료');
  assert.equal(completed.date, '2099-09-12');
  assert.equal(completed.fee, 700000);
  assert.equal(completed.siteAddress, '변경 주소');
});

test('contract schedules and expiry follow the selected document work date before the period start', async () => {
  const pool = new LedgerPool();
  const repository = new AppRepository(pool);
  const contract = await repository.createContract(7, example({
    startDate: '2000-09-11', endDate: '2000-09-11', documentDate: '2099-09-11', status: 'saved',
  }));
  assert.equal(contract.progress, 'scheduled');
  const schedule = await repository.getSchedule(7, pool.schedules[0].id);
  assert.equal(schedule.date, '2099-09-11');
  assert.equal(schedule.status, 'scheduled');
  const edited = await repository.updateContract(7, contract.id, {
    ...contract, documentDate: '2099-09-12', fee: 700000,
  });
  assert.equal(edited.progress, 'scheduled');
  const paid = await repository.updateSchedule(7, schedule.id, { ...schedule, status: 'settled' }, { statusOnly: true });
  assert.equal(paid.date, '2099-09-12');
  assert.equal(paid.status, 'scheduled');
  assert.equal(paid.fee, 700000);
  await repository.updateSchedule(7, schedule.id, { ...paid, status: 'unpaid' }, { statusOnly: true });
  const expired = await repository.updateContract(7, contract.id, {
    ...edited, documentDate: '2000-09-12', startDate: '2099-09-11', endDate: '2099-09-11',
  });
  assert.equal(expired.progress, 'ended');
  assert.equal((await repository.getSchedule(7, schedule.id)).date, '2000-09-12');
  assert.equal(contractWorkDate({ startDate: '2099-09-11', documentDate: '2099-02-30' }), '2099-09-11');
});
