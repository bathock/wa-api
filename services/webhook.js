import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from './logger.js';

export async function sendWebhook(event, payload = {}) {
  if (!config.webhookEnabled || !config.webhookUrl) return false;

  try {
    await axios.post(config.webhookUrl, {
      event,
      timestamp: new Date().toISOString(),
      data: payload
    }, {
      timeout: 10_000,
      headers: config.webhookSecret ? { 'X-Webhook-Secret': config.webhookSecret } : undefined
    });
    return true;
  } catch (error) {
    logger.warn({ err: error.message }, 'Webhook failed');
    return false;
  }
}
