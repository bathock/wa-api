import { Router } from 'express';
import { sendMessage, sendFile } from '../controllers/message.controller.js';

const router = Router();
router.post('/session/:sessionId/send-message', sendMessage);
router.post('/session/:sessionId/send-file', sendFile);

export default router;
