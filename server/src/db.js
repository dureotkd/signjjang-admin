const mysql = require('mysql2/promise');

const { config } = require('./config');

const pool = mysql.createPool({
  ...config.db,
  charset: 'utf8mb4',
  // A DATE has no timezone. Preserve calendar dates while DATETIME values
  // remain Date objects for authentication deadlines and timestamps.
  dateStrings: ['DATE'],
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  namedPlaceholders: true,
  queueLimit: 0,
  waitForConnections: true,
});

module.exports = { pool };
