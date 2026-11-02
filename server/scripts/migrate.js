const fs = require('node:fs/promises');
const path = require('node:path');

const mysql = require('mysql2/promise');

const { config } = require('../src/config');

const siteCoordinateSchema = [
  {
    columns: [
      ['site_latitude', 'DECIMAL(9,6) NULL AFTER `fee`'],
      ['site_longitude', 'DECIMAL(9,6) NULL AFTER `site_latitude`'],
    ],
    index: 'idx_contracts_user_site_coordinates',
    table: 'contracts',
  },
  {
    columns: [
      ['site_latitude', 'DECIMAL(9,6) NULL AFTER `fee`'],
      ['site_longitude', 'DECIMAL(9,6) NULL AFTER `site_latitude`'],
    ],
    index: 'idx_schedules_user_site_coordinates',
    table: 'schedules',
  },
];

async function hasColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
     LIMIT 1`,
    [table, column],
  );
  return Boolean(rows[0]);
}

async function hasIndex(connection, table, index) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     LIMIT 1`,
    [table, index],
  );
  return Boolean(rows[0]);
}

// DDL commits implicitly in MySQL/MariaDB. Applying each component after an
// information_schema check allows a re-run to recover safely if a prior 004
// attempt stopped after adding only some columns or indexes.
async function ensureSiteCoordinateSchema(connection) {
  for (const entity of siteCoordinateSchema) {
    for (const [column, definition] of entity.columns) {
      if (!(await hasColumn(connection, entity.table, column))) {
        await connection.query(`ALTER TABLE \`${entity.table}\` ADD COLUMN \`${column}\` ${definition}`);
      }
    }
    if (!(await hasIndex(connection, entity.table, entity.index))) {
      await connection.query(
        `ALTER TABLE \`${entity.table}\` ADD KEY \`${entity.index}\` (\`user_id\`, \`site_latitude\`, \`site_longitude\`)`,
      );
    }
  }
}

async function migrate() {
  const bootstrap = await mysql.createConnection({
    charset: 'utf8mb4',
    connectTimeout: config.db.connectTimeout,
    host: config.db.host,
    password: config.db.password,
    port: config.db.port,
    user: config.db.user,
  });

  const database = mysql.escapeId(config.db.database);
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  const connection = await mysql.createConnection({
    charset: 'utf8mb4',
    connectTimeout: config.db.connectTimeout,
    database: config.db.database,
    host: config.db.host,
    multipleStatements: true,
    password: config.db.password,
    port: config.db.port,
    user: config.db.user,
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) NOT NULL PRIMARY KEY,
        executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);
    const [executedRows] = await connection.query('SELECT filename FROM schema_migrations');
    const executed = new Set(executedRows.map((row) => row.filename));
    const sqlDir = path.resolve(__dirname, '..', 'sql');
    const files = (await fs.readdir(sqlDir)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (executed.has(file)) continue;
      const sql = await fs.readFile(path.join(sqlDir, file), 'utf8');
      await connection.beginTransaction();
      try {
        if (file === '004_site_coordinates.sql') {
          await ensureSiteCoordinateSchema(connection);
        } else {
          await connection.query(sql);
        }
        await connection.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
        await connection.commit();
        console.info(`적용 완료: ${file}`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error(`마이그레이션 실패: ${error.message}`);
  process.exitCode = 1;
});
