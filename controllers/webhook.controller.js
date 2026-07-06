import { config } from '../config/index.js';

export async function webhookInfo(req, res) {
  res.json({
    success: true,
    enabled: config.webhookEnabled,
    urlConfigured: Boolean(config.webhookUrl)
  });
}
