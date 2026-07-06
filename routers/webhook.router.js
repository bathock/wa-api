import { Router } from 'express';
import { webhookInfo } from '../controllers/webhook.controller.js';

const router = Router();
router.get('/webhook/info', webhookInfo);

export default router;
