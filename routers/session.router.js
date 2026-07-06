import { Router } from 'express';
import { createSession, listSessions, sessionInfo, sessionQr, deleteSession } from '../controllers/session.controller.js';

const router = Router();
router.post('/session/create', createSession);
router.post('/session/:sessionId/create', createSession);
router.get('/sessions', listSessions);
router.get('/session/:sessionId/info', sessionInfo);
router.get('/session/:sessionId/qr', sessionQr);
router.delete('/session/:sessionId', deleteSession);

export default router;
