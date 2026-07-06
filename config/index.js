import dotenv from 'dotenv';
dotenv.config();

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 5000),
  maxSessions: num(process.env.MAX_SESSIONS, 5),
  messageLimitPerHour: num(process.env.MESSAGE_LIMIT_PER_HOUR, 120),
  webhookEnabled: bool(process.env.WEBHOOK_ENABLED, false),
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  typingMinSeconds: num(process.env.TYPING_MIN_SECONDS, 3),
  typingMaxSeconds: num(process.env.TYPING_MAX_SECONDS, 8),
  autoRestoreSessions: bool(process.env.AUTO_RESTORE_SESSIONS, true),
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'wa_gateway',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'wa_gateway',
    connectionLimit: num(process.env.DB_CONNECTION_LIMIT, 10)
  }
};
