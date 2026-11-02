const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { toItem } = require('../src/admin/repository');

// Exercise the installed driver's real DATE/DATETIME parser with the production
// pool settings. No connection or local environment credentials are required.
test('calendar dates survive Korean timezone parsing while expiry timestamps remain Date objects', async () => {
  const databaseModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8'), {
    module: databaseModule,
    require(name) {
      if (name === './config') return { config: { db: {} } };
      if (name === 'mysql2/promise') return mysql;
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const pool = databaseModule.exports.pool;
  try {
    const mysqlRoot = path.dirname(require.resolve('mysql2/package.json'));
    const getParser = require(path.join(mysqlRoot, 'lib/parsers/text_parser.js'));
    const Packet = require(path.join(mysqlRoot, 'lib/packets/packet.js'));
    const types = require(path.join(mysqlRoot, 'lib/constants/types.js'));
    const fields = [
      { name: 'start_date', columnType: types.DATE, characterSet: 63, encoding: 'ascii' },
      { name: 'expires_at', columnType: types.DATETIME, characterSet: 63, encoding: 'ascii' },
    ];
    const encode = (value) => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]);
    for (const timezone of ['+09:00', '-08:00']) {
      const config = { ...pool.pool.config.connectionConfig, timezone };
      const buffer = Buffer.concat([Buffer.alloc(4), encode('2026-11-01'), encode('2026-11-01 00:00:00')]);
      const parser = new (getParser(fields, {}, config))(fields);
      const row = parser.next(new Packet(0, buffer, 0, buffer.length), fields, {});
      assert.equal(row.start_date, '2026-11-01');
      assert.ok(row.expires_at instanceof Date);
      assert.equal(toItem(row).startDate, '2026-11-01');
      assert.equal(row.expires_at.toISOString(), timezone === '+09:00' ? '2026-10-31T15:00:00.000Z' : '2026-11-01T08:00:00.000Z');
    }
  } finally { await pool.end(); }
});
