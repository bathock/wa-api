import whatsapp from '../services/whatsapp.service.js';

export async function sendMessage(req, res) {
  try {
    const { sessionId } = req.params;
    const { number, message, messageId, skipDuplicateCheck, deduplicationTTL } = req.body;
    const result = await whatsapp.sendMessage(sessionId, number, message, { messageId, skipDuplicateCheck, deduplicationTTL });
    res.json(result);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 400;
    res.status(statusCode).json({
      success: false,
      error: error.code || error.message,
      message: error.message,
      restricted: error.restricted === true,
      restrictionCode: error.restrictionCode || null,
      restrictionType: error.restrictionType || null,
      restrictionReason: error.restrictionReason || null,
      restrictionEndsAt: error.restrictionEndsAt || null,
      reachoutTimeLock: error.reachoutTimeLock || null
    });
  }
}

export async function sendFile(req, res) {
  try {
    const { sessionId } = req.params;
    const { number, fileUrl, caption, messageId, skipDuplicateCheck, deduplicationTTL } = req.body;
    const result = await whatsapp.sendFile(sessionId, number, fileUrl, caption || '', { messageId, skipDuplicateCheck, deduplicationTTL });
    res.json(result);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 400;
    res.status(statusCode).json({
      success: false,
      error: error.code || error.message,
      message: error.message,
      restricted: error.restricted === true,
      restrictionCode: error.restrictionCode || null,
      restrictionType: error.restrictionType || null,
      restrictionReason: error.restrictionReason || null,
      restrictionEndsAt: error.restrictionEndsAt || null,
      reachoutTimeLock: error.reachoutTimeLock || null
    });
  }
}
