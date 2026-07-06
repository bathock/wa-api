import whatsapp from '../services/whatsapp.service.js';

export async function createSession(req, res) {
  try {
    const sessionId = req.body.sessionId || req.params.sessionId;
    const result = await whatsapp.createSession(sessionId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
}

export async function listSessions(req, res) {
  try {
    res.json({ success: true, data: whatsapp.listSessions() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
}

export async function sessionInfo(req, res) {
  try {
    await Promise.allSettled([
      whatsapp.refreshProfile(req.params.sessionId),
      whatsapp.refreshReachoutTimelock(req.params.sessionId, 'session_info')
    ]);
    res.json({ success: true, data: whatsapp.getSessionInfo(req.params.sessionId) });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
}

export async function sessionQr(req, res) {
  try {
    const qr = whatsapp.getQr(req.params.sessionId);
    if (!qr) return res.status(404).json({ success: false, error: 'QR not ready or session already connected' });
    res.json({ success: true, qr });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
}

export async function deleteSession(req, res) {
  try {
    const result = await whatsapp.deleteSession(req.params.sessionId, true);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
}
