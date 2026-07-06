import mysql from 'mysql2/promise';
import { config } from './index.js';
import { logger } from '../services/logger.js';

export const database = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
  waitForConnections: true,
  connectionLimit: config.database.connectionLimit,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4',
  timezone: 'Z'
});

const AUTH_TABLES = [
  `CREATE TABLE IF NOT EXISTS wa_auth_sessions (
    session_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    creds LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS wa_auth_keys (
    session_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    category VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    key_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    key_data LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, category, key_id),
    INDEX idx_wa_auth_keys_session_category (session_id, category)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

export async function initializeDatabase() {
  const connection = await database.getConnection();

  try {
    await connection.ping();

    for (const sql of AUTH_TABLES) {
      await connection.query(sql);
    }

    logger.info(
      `MariaDB auth storage ready: ${config.database.host}:${config.database.port}/${config.database.name}`
    );
  } finally {
    connection.release();
  }
}

export async function closeDatabase() {
  await database.end();
}

export default database;
