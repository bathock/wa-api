import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { initializeDatabase } from './config/database.js';
import { logger } from './services/logger.js';
import whatsapp from './services/whatsapp.service.js';
import messageRouter from './routers/message.router.js';
import sessionRouter from './routers/session.router.js';
import webhookRouter from './routers/webhook.router.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'WA Gateway Baileys',
    authStorage: 'mariadb',
    webhook: config.webhookEnabled ? 'enabled' : 'disabled'
  });
});

app.use('/api/whatsapp', sessionRouter);
app.use('/api/whatsapp', messageRouter);
app.use('/api/whatsapp', webhookRouter);

app.use((req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

async function start() {
  await initializeDatabase();

  app.listen(config.port, config.host, async () => {
    logger.info(`Server running on http://${config.host}:${config.port}`);
    logger.info(`Auth storage: MariaDB (${config.database.name})`);
    logger.info(`Webhook: ${config.webhookEnabled ? 'Enabled' : 'Disabled'}`);

    try {
      await whatsapp.autoRestore();
    } catch (error) {
      logger.error({ err: error.message }, 'Auto restore failed');
    }
  });
}

start().catch(error => {
  logger.error({ err: error.message }, 'Startup failed');
  process.exit(1);
});
