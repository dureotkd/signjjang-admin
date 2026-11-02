const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AppRepository } = require('../src/repositories/app.repository');
const { AppError } = require('../src/errors');
const { AppService } = require('../src/services/app.service');

test('duplicate contact phone returns a conflict instead of a server error', async () => {
  const repository = new AppRepository({
    async execute() { throw Object.assign(new Error('duplicate phone'), { code: 'ER_DUP_ENTRY' }); },
  });
  await assert.rejects(repository.createAlliance(7, { tradeName: '', contactName: '테스트', phone: '01000009999' }),
    (error) => error instanceof AppError && error.status === 409 && error.code === 'CONTACT_ALREADY_EXISTS');
});

test('contact registration preserves unexpected database errors', async () => {
  const databaseError = Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' });
  const repository = new AppRepository({ async execute() { throw databaseError; } });
  await assert.rejects(repository.createAlliance(7, { tradeName: '', contactName: '테스트', phone: '01000009999' }),
    (error) => error === databaseError);
});

test('contact update scopes both the write and read to the owner and phone', async () => {
  const calls = [];
  const row = { id: 15, trade_name: '', contact_name: '수정 이름', phone: '01000009999', created_at: '2026-09-14T00:00:00Z' };
  const repository = new AppRepository({
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      assert.match(sql, /WHERE user_id = \? AND phone = \?/);
      // An unchanged value can report zero affected rows and must still succeed.
      return sql.startsWith('UPDATE') ? [{ affectedRows: 0 }] : [[row]];
    },
  });
  const result = await repository.updateAllianceByPhone(7, { tradeName: '', contactName: '수정 이름', phone: row.phone });
  assert.deepEqual(calls[0].parameters, ['', '수정 이름', 7, row.phone]);
  assert.deepEqual(calls[1].parameters, [7, row.phone]);
  assert.equal(result.id, '15');
});

test('missing or another owner contact cannot be created through the update endpoint', async () => {
  const repository = new AppRepository({ async execute(sql) { return sql.startsWith('UPDATE') ? [{ affectedRows: 0 }] : [[]]; } });
  const service = new AppService(repository);
  await assert.rejects(service.updateAllianceByPhone(7, { tradeName: '', contactName: '수정 이름', phone: '01000009999' }),
    (error) => error.status === 404 && error.code === 'CONTACT_NOT_FOUND');
});
