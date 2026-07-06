import makeWASocket, {
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  isRealMessage,
  isWABusinessPlatform,
  makeCacheableSignalKeyStore,
  ACCOUNT_RESTRICTED_TEXT
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import mime from 'mime-types';
import pino from 'pino';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import messageDeduplicator from './messageDeduplicator.js';
import { sendWebhook } from './webhook.js';
import {
  useDatabaseAuthState,
  ensureAuthSession,
  listAuthSessionIds,
  deleteAuthSession
} from './auth/database-auth-state.js';

export const SESSION_STATE = {
  INIT: 'initializing',
  QR: 'qr',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  LOGGED_OUT: 'loggedOut',
  FAILED: 'failed',
  RESTRICTED: 'restricted'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const ACCOUNT_RESTRICTED_CODE = 463;
const CONTACT_CACHE_TTL_MS = 5 * 60 * 1000;
const JID_CACHE_TTL_MS = 5 * 60 * 1000;
const SENT_MESSAGE_CACHE_TTL_MS = 60 * 60 * 1000;

class WhatsAppService {
  constructor() {
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.connecting = new Set();
    this.messageStats = new Map();
    this.queues = new Map();
    this.jidCache = new Map();
    this.contactCache = new Map();
    this.sentMessageCache = new Map();
    this.restrictionTimers = new Map();

    setInterval(() => {
      this.cleanupStats();
      this.cleanupCaches();
    }, 60_000).unref();
  }

  async safeWebhook(event, payload) {
    try {
      await sendWebhook(event, payload);
    } catch (err) {
      logger.warn({ err: err.message, event }, 'Webhook failed');
    }
  }

  getErrorText(error) {
    const values = [
      error?.message,
      error?.code,
      error?.output?.payload?.message,
      error?.output?.payload?.error,
      error?.output?.payload?.code,
      error?.output?.payload,
      error?.data?.message,
      error?.data?.error,
      error?.data?.code,
      error?.data,
      error?.cause?.message,
      error?.cause
    ];

    return values
      .filter(value => value !== undefined && value !== null)
      .map(value => {
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return String(value);

        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(' | ');
  }

  getErrorCode(error) {
    const candidates = [
      error?.restrictionCode,
      error?.statusCode,
      error?.code,
      error?.output?.statusCode,
      error?.output?.payload?.statusCode,
      error?.output?.payload?.code,
      error?.data?.statusCode,
      error?.data?.code,
      error?.cause?.statusCode,
      error?.cause?.code
    ];

    for (const value of candidates) {
      const code = Number(value);
      if (Number.isFinite(code)) return code;
    }

    const text = this.getErrorText(error);
    const match = text.match(/(?:^|\D)463(?:\D|$)/);
    return match ? ACCOUNT_RESTRICTED_CODE : null;
  }

  isRestrictionError(error) {
    const text = this.getErrorText(error).toLowerCase();
    const code = this.getErrorCode(error);

    return (
      code === ACCOUNT_RESTRICTED_CODE ||
      text.includes(ACCOUNT_RESTRICTED_TEXT.toLowerCase()) ||
      text.includes('account restricted') ||
      text.includes('messageaccountrestriction')
    );
  }

  async markSessionRestricted(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (session.restrictionType === 'reachout_timelock' && session.restricted) {
      return session;
    }

    const code = ACCOUNT_RESTRICTED_CODE;
    const reason = this.getErrorText(error) || ACCOUNT_RESTRICTED_TEXT;

    session.state = SESSION_STATE.RESTRICTED;
    session.restricted = true;
    session.restrictionCode = code;
    session.restrictionType = 'server_463';
    session.restrictionReason = reason;
    session.restrictedAt = session.restrictedAt || new Date().toISOString();
    session.restrictionEndsAt = null;
    session.lastDisconnect = reason;
    session.updatedAt = new Date().toISOString();

    logger.error(`[${sessionId}] ACCOUNT RESTRICTED code=${code} reason=${reason}`);

    await this.safeWebhook('session.restricted', {
      sessionId,
      code,
      type: session.restrictionType,
      reason,
      restrictedAt: session.restrictedAt,
      endsAt: null
    });

    return session;
  }

  createRestrictionError(sessionId, error) {
    const session = this.sessions.get(sessionId);
    const restrictionType = session?.restrictionType || error?.restrictionType || 'server_463';
    const isReachoutTimelock = restrictionType === 'reachout_timelock';
    const message = session?.restrictionReason || this.getErrorText(error) || ACCOUNT_RESTRICTED_TEXT;
    const restrictedError = new Error(message);
    restrictedError.code = isReachoutTimelock ? 'REACHOUT_TIMELOCK' : 'ACCOUNT_RESTRICTED';
    restrictedError.statusCode = 403;
    restrictedError.restricted = true;
    restrictedError.restrictionCode = session?.restrictionCode || ACCOUNT_RESTRICTED_CODE;
    restrictedError.restrictionType = restrictionType;
    restrictedError.restrictionReason = message;
    restrictedError.restrictionEndsAt = session?.restrictionEndsAt || null;
    restrictedError.reachoutTimeLock = session?.reachoutTimeLock || null;
    restrictedError.sessionId = sessionId;
    return restrictedError;
  }

  async throwIfRestricted(sessionId, error) {
    if (!this.isRestrictionError(error)) return false;

    await this.markSessionRestricted(sessionId, error);
    throw this.createRestrictionError(sessionId, error);
  }

  toIsoDate(value) {
    if (value === undefined || value === null || value === '') return null;

    let date;

    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      const number = Number(value);
      date = new Date(number < 1_000_000_000_000 ? number * 1000 : number);
    } else {
      date = new Date(value);
    }

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  clearRestrictionTimer(sessionId) {
    const timer = this.restrictionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.restrictionTimers.delete(sessionId);
  }

  scheduleReachoutAutoClear(sessionId, endsAt) {
    this.clearRestrictionTimer(sessionId);
    if (!endsAt) return;

    const delay = new Date(endsAt).getTime() - Date.now();
    if (!Number.isFinite(delay)) return;

    if (delay <= 0) {
      queueMicrotask(() => {
        this.clearSessionRestriction(sessionId, {
          source: 'expiry',
          reason: 'reachout_timelock_expired'
        }).catch(() => {});
      });
      return;
    }

    const safeDelay = Math.min(delay + 250, 2_147_000_000);
    const timer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      const currentEndsAt = current?.restrictionEndsAt;
      const remaining = currentEndsAt ? new Date(currentEndsAt).getTime() - Date.now() : 0;

      if (remaining > 0) {
        this.scheduleReachoutAutoClear(sessionId, currentEndsAt);
        return;
      }

      this.clearSessionRestriction(sessionId, {
        source: 'expiry',
        reason: 'reachout_timelock_expired'
      }).catch(err => {
        logger.warn({ err: err.message, sessionId }, 'failed to auto-clear reachout timelock');
      });
    }, safeDelay);

    timer.unref();
    this.restrictionTimers.set(sessionId, timer);
  }

  async clearSessionRestriction(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const wasRestricted = session.restricted === true;
    const previous = session.reachoutTimeLock || null;
    const source = options.source || 'unknown';
    const reason = options.reason || 'restriction_cleared';

    this.clearRestrictionTimer(sessionId);

    session.restricted = false;
    session.restrictionCode = null;
    session.restrictionType = null;
    session.restrictionReason = null;
    session.restrictedAt = null;
    session.restrictionEndsAt = null;
    session.reachoutTimeLock = {
      active: false,
      enforcementType: previous?.enforcementType || null,
      endsAt: null,
      source,
      updatedAt: new Date().toISOString()
    };

    if (session.connected) {
      session.state = SESSION_STATE.CONNECTED;
    } else if (session.state === SESSION_STATE.RESTRICTED) {
      session.state = SESSION_STATE.DISCONNECTED;
    }

    session.updatedAt = new Date().toISOString();

    if (wasRestricted || previous?.active) {
      logger.info(`[${sessionId}] reachout timelock cleared source=${source} reason=${reason}`);
      await this.safeWebhook('session.reachout_timelock', {
        sessionId,
        active: false,
        enforcementType: previous?.enforcementType || null,
        endsAt: null,
        source,
        reason
      });
    }

    return session;
  }

  async applyReachoutTimelock(sessionId, state, source = 'event') {
    const session = this.sessions.get(sessionId);
    if (!session || !state) return null;

    const active = state.isActive === true;
    const enforcementType = state.enforcementType || 'DEFAULT';
    const endsAt = this.toIsoDate(state.timeEnforcementEnds);

    if (!active || (endsAt && new Date(endsAt).getTime() <= Date.now())) {
      return this.clearSessionRestriction(sessionId, {
        source,
        reason: active ? 'reachout_timelock_expired' : 'reachout_timelock_lifted'
      });
    }

    const previous = session.reachoutTimeLock || {};
    const changed =
      previous.active !== true ||
      previous.enforcementType !== enforcementType ||
      previous.endsAt !== endsAt;

    session.state = SESSION_STATE.RESTRICTED;
    session.restricted = true;
    session.restrictionCode = ACCOUNT_RESTRICTED_CODE;
    session.restrictionType = 'reachout_timelock';
    session.restrictionReason = `Reachout timelock: ${enforcementType}`;
    session.restrictedAt = session.restrictedAt || new Date().toISOString();
    session.restrictionEndsAt = endsAt;
    session.reachoutTimeLock = {
      active: true,
      enforcementType,
      endsAt,
      source,
      updatedAt: new Date().toISOString()
    };
    session.updatedAt = new Date().toISOString();

    this.scheduleReachoutAutoClear(sessionId, endsAt);

    if (changed) {
      logger.error(`[${sessionId}] REACHOUT TIMELOCK type=${enforcementType} endsAt=${endsAt || 'unknown'}`);
      await this.safeWebhook('session.reachout_timelock', {
        sessionId,
        active: true,
        enforcementType,
        endsAt,
        source,
        restrictedAt: session.restrictedAt
      });
    }

    return session;
  }

  async refreshReachoutTimelock(sessionId, source = 'fetch') {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) return null;

    if (typeof session.socket.fetchAccountReachoutTimelock !== 'function') {
      logger.warn(`[${sessionId}] fetchAccountReachoutTimelock unavailable`);
      return null;
    }

    try {
      const state = await session.socket.fetchAccountReachoutTimelock();
      await this.applyReachoutTimelock(sessionId, state, source);
      return state;
    } catch (error) {
      logger.warn({ err: error.message, sessionId }, 'failed to fetch reachout timelock');
      return null;
    }
  }

  async assertSessionCanSend(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    if (
      session.restricted &&
      session.restrictionType === 'reachout_timelock' &&
      session.restrictionEndsAt &&
      new Date(session.restrictionEndsAt).getTime() <= Date.now()
    ) {
      await this.clearSessionRestriction(sessionId, {
        source: 'send_guard',
        reason: 'reachout_timelock_expired'
      });
    }

    if (session.restricted || session.state === SESSION_STATE.RESTRICTED) {
      throw this.createRestrictionError(sessionId, session);
    }

    return true;
  }

  createSessionObject(sessionId) {
    return {
      id: sessionId,
      state: SESSION_STATE.INIT,
      socket: null,
      connected: false,
      number: null,
      name: null,
      photo: null,
      platform: null,
      isBusiness: false,
      qr: null,
      lastDisconnect: null,
      reconnectAttempts: 0,
      restricted: false,
      restrictionCode: null,
      restrictionType: null,
      restrictionReason: null,
      restrictedAt: null,
      restrictionEndsAt: null,
      reachoutTimeLock: {
        active: false,
        enforcementType: null,
        endsAt: null,
        source: null,
        updatedAt: null
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async waitForQrOrConnected(sessionId, timeoutMs = 15000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error('Session not found');

      if (session.state === SESSION_STATE.CONNECTED) return true;
      if (session.state === SESSION_STATE.QR && this.qrCodes.has(sessionId)) return true;

      await sleep(300);
    }

    return false;
  }

  async runQueue(sessionId, job) {
    const prev = this.queues.get(sessionId) || Promise.resolve();

    const next = prev
      .then(job, job)
      .finally(() => {
        if (this.queues.get(sessionId) === next) {
          this.queues.delete(sessionId);
        }
      });

    this.queues.set(sessionId, next);
    return next;
  }

  async createSession(sessionId) {
    if (!sessionId) throw new Error('sessionId required');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) {
      throw new Error('sessionId must use only letters, numbers, underscore, or hyphen (max 100)');
    }

    await ensureAuthSession(sessionId, config.maxSessions);

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, this.createSessionObject(sessionId));
    }

    await this.connectSession(sessionId);
    await this.waitForQrOrConnected(sessionId);

    return this.getSessionInfo(sessionId);
  }

  async waitSocketOpen(socket, timeoutMs = 15000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (socket?.ws?.isOpen === true || socket?.ws?.readyState === 1) {
        return true;
      }

      await sleep(300);
    }

    throw new Error('WhatsApp socket is not open');
  }

  async connectSession(sessionId) {
    return this.runQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error('Session not found');

      if (
        session.socket &&
        [SESSION_STATE.CONNECTED, SESSION_STATE.CONNECTING, SESSION_STATE.QR].includes(session.state)
      ) {
        return true;
      }

      if (this.connecting.has(sessionId)) return true;

      this.connecting.add(sessionId);

      session.state = SESSION_STATE.CONNECTING;
      session.connected = false;
      session.lastDisconnect = null;
      session.updatedAt = new Date().toISOString();

      try {
        await this.closeSocket(session);

        const { state, saveCreds } = await useDatabaseAuthState(sessionId);

        this.updateSessionPlatform(sessionId, state.creds?.platform);

        const signalKeyStore = makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: 'silent' })
        );

        const socket = makeWASocket({
          auth: {
            creds: state.creds,
            keys: signalKeyStore
          },
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          logger: pino({ level: 'silent' }),
          markOnlineOnConnect: false,
          syncFullHistory: false,
          shouldSyncHistoryMessage: () => false,
          emitOwnEvents: true,
          generateHighQualityLinkPreview: false,
          defaultQueryTimeoutMs: 60_000,
          connectTimeoutMs: 60_000,
          keepAliveIntervalMs: 20_000,
          retryRequestDelayMs: 2000,
          getMessage: async key => this.getCachedMessage(sessionId, key)
        });

        session.socket = socket;
        session.updatedAt = new Date().toISOString();

        socket.ev.on('creds.update', update => {
          saveCreds()
            .then(() => this.updateSessionPlatform(sessionId, update?.platform || state.creds?.platform))
            .catch(err => logger.warn({ err: err.message, sessionId }, 'save creds failed'));
        });
        socket.ev.on('connection.update', update => this.onConnectionUpdate(sessionId, update));
        socket.ev.on('messages.upsert', payload => this.onMessagesUpsert(sessionId, payload));
        socket.ev.on('contacts.upsert', contacts => this.onContactsUpsert(sessionId, contacts));
        socket.ev.on('contacts.update', contacts => this.onContactsUpsert(sessionId, contacts));
        socket.ev.on('lid-mapping.update', mapping => this.onLidMappingUpdate(sessionId, mapping));

        return true;
      } catch (error) {
        session.state = SESSION_STATE.FAILED;
        session.connected = false;
        session.lastDisconnect = error.message;
        session.updatedAt = new Date().toISOString();

        await this.closeSocket(session).catch(() => {});

        logger.error({ err: error.message, sessionId }, 'connectSession failed');
        throw error;
      } finally {
        this.connecting.delete(sessionId);
      }
    });
  }

  async closeSocket(session) {
    if (!session?.socket) return;

    try {
      session.socket.ev?.removeAllListeners?.();
    } catch {}

    try {
      session.socket.ws?.close?.();
    } catch {}

    try {
      session.socket.end?.();
    } catch {}

    session.socket = null;
  }

  async onConnectionUpdate(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr, reachoutTimeLock } = update;

    if (qr) {
      session.state = SESSION_STATE.QR;
      session.connected = false;
      session.qr = qr;
      session.updatedAt = new Date().toISOString();

      this.qrCodes.set(sessionId, await qrcode.toDataURL(qr));

      console.clear();
      console.log('\n========================================');
      console.log(`📱 SCAN QR WHATSAPP SESSION: ${sessionId}`);
      console.log('========================================\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n========================================');
      console.log('Buka WhatsApp > Perangkat tertaut > Tautkan perangkat');
      console.log('========================================\n');

      logger.info(`QR ready for session: ${sessionId}`);
      await this.safeWebhook('session.qr', { sessionId });
    }

    if (connection === 'open') {
      session.connected = true;
      session.state = session.restricted ? SESSION_STATE.RESTRICTED : SESSION_STATE.CONNECTED;
      session.qr = null;
      session.reconnectAttempts = 0;
      session.lastDisconnect = null;
      session.updatedAt = new Date().toISOString();

      const userId = session.socket?.user?.id || '';
      session.number = userId.split(':')[0]?.replace(/\D/g, '') || session.number;
      session.name = session.socket?.user?.name || session.socket?.user?.verifiedName || session.name;

      this.qrCodes.delete(sessionId);

      await this.refreshProfile(sessionId).catch(() => {});
      if (reachoutTimeLock) {
        await this.applyReachoutTimelock(sessionId, reachoutTimeLock, 'connection_open');
      } else {
        await this.refreshReachoutTimelock(sessionId, 'connection_open');
      }
      await this.safeWebhook('session.connected', this.getSessionInfo(sessionId));

      logger.info(`Session connected: ${sessionId}`);
    } else if (reachoutTimeLock) {
      await this.applyReachoutTimelock(sessionId, reachoutTimeLock, 'connection_update');
    }

    if (connection === 'close') {
      const disconnectError = lastDisconnect?.error;
      const statusCode = disconnectError?.output?.statusCode;

      if (this.isRestrictionError(disconnectError)) {
        session.connected = false;
        await this.markSessionRestricted(sessionId, disconnectError);
        await this.closeSocket(session);
        return;
      }

      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401 ||
        statusCode === 403;
      const badSession = statusCode === DisconnectReason.badSession || statusCode === 500;

      session.connected = false;
      session.state = isLoggedOut
        ? SESSION_STATE.LOGGED_OUT
        : session.restricted
          ? SESSION_STATE.RESTRICTED
          : SESSION_STATE.DISCONNECTED;
      session.lastDisconnect = lastDisconnect?.error?.message || String(statusCode || 'connection closed');
      session.updatedAt = new Date().toISOString();

      await this.closeSocket(session);
      await this.safeWebhook('session.disconnected', {
        sessionId,
        statusCode,
        reason: session.lastDisconnect
      });

      if (isLoggedOut || badSession) {
        await this.deleteSession(sessionId, true);
        await this.safeWebhook('session.deleted', {
          sessionId,
          reason: isLoggedOut ? 'loggedOut' : 'badSession'
        });
        return;
      }

      session.reconnectAttempts += 1;
      const delay = Math.min(30_000, 2_000 * session.reconnectAttempts);

      setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          this.connectSession(sessionId).catch(err => {
            logger.warn({ err: err.message, sessionId }, 'reconnect failed');
          });
        }
      }, delay).unref();
    }
  }

  updateSessionPlatform(sessionId, platform) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.platform = platform || session.platform || null;
    session.isBusiness = session.platform ? isWABusinessPlatform(session.platform) : false;
    session.updatedAt = new Date().toISOString();
  }

  normalizeJid(value) {
    const raw = String(value || '').trim();
    if (!raw || !raw.includes('@')) return null;

    try {
      return jidNormalizedUser(raw);
    } catch {
      return raw;
    }
  }

  isLidJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@lid');
  }

  isPhoneJid(jid) {
    return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
  }

  phoneNumberFromJid(jid) {
    if (!this.isPhoneJid(jid)) return null;
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '') || null;
  }

  normalizePhoneJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    if (raw.includes('@')) {
      const jid = this.normalizeJid(raw);
      if (!this.isPhoneJid(jid)) return null;
      const number = this.phoneNumberFromJid(jid);
      return number ? `${number}@s.whatsapp.net` : null;
    }

    const number = raw.replace(/\D/g, '');
    return number ? `${number}@s.whatsapp.net` : null;
  }

  normalizeLidJid(value) {
    const jid = this.normalizeJid(value);
    return this.isLidJid(jid) ? jid : null;
  }

  contactCacheKey(sessionId, jid) {
    return `${sessionId}:${jid}`;
  }

  getCachedContact(sessionId, jid) {
    const normalized = this.normalizeJid(jid);
    if (!normalized) return null;

    const key = this.contactCacheKey(sessionId, normalized);
    const cached = this.contactCache.get(key);

    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.contactCache.delete(key);
      return null;
    }

    return cached.contact;
  }

  cacheContact(sessionId, contact = {}) {
    const id = this.normalizeJid(contact.id || contact.jid);
    const lid = this.normalizeLidJid(contact.lid) || (this.isLidJid(id) ? id : null);
    const phoneJid = this.normalizePhoneJid(contact.phoneNumber) || (this.isPhoneJid(id) ? this.normalizePhoneJid(id) : null);

    const aliases = [id, lid, phoneJid].filter(Boolean);
    if (!aliases.length) return null;

    let existing = null;
    for (const alias of aliases) {
      existing = this.getCachedContact(sessionId, alias);
      if (existing) break;
    }

    const merged = {
      ...(existing || {}),
      id: id || existing?.id || lid || phoneJid,
      lid: lid || existing?.lid || null,
      phoneNumber: phoneJid || existing?.phoneNumber || null,
      name: contact.name || existing?.name || null,
      notify: contact.notify || existing?.notify || null,
      verifiedName: contact.verifiedName || existing?.verifiedName || null,
      imgUrl: contact.imgUrl || existing?.imgUrl || null,
      status: contact.status || existing?.status || null,
      updatedAt: new Date().toISOString()
    };

    const allAliases = new Set([
      ...aliases,
      merged.id,
      merged.lid,
      merged.phoneNumber
    ].filter(Boolean));

    const expiresAt = Date.now() + CONTACT_CACHE_TTL_MS;
    for (const alias of allAliases) {
      this.contactCache.set(this.contactCacheKey(sessionId, alias), {
        contact: merged,
        expiresAt
      });
    }

    return merged;
  }

  cacheLidPhonePair(sessionId, first, second, extra = {}) {
    const values = [this.normalizeJid(first), this.normalizeJid(second)].filter(Boolean);
    const lid = values.find(value => this.isLidJid(value));
    const phoneJid = values.find(value => this.isPhoneJid(value));

    if (!lid || !phoneJid) return null;

    return this.cacheContact(sessionId, {
      ...extra,
      id: lid,
      lid,
      phoneNumber: phoneJid
    });
  }

  onContactsUpsert(sessionId, contacts = []) {
    for (const contact of contacts || []) {
      this.cacheContact(sessionId, contact);
    }
  }

  onLidMappingUpdate(sessionId, mapping = {}) {
    const lid = this.normalizeLidJid(mapping.lid);
    const phoneJid = this.normalizePhoneJid(mapping.pn || mapping.phoneNumber);

    if (!lid || !phoneJid) return null;

    const contact = this.cacheLidPhonePair(sessionId, lid, phoneJid);
    logger.info(`[${sessionId}] LID mapping updated ${phoneJid} <-> ${lid}`);
    return contact;
  }

  getMessageIdentity(message) {
    const key = message?.key || {};
    const identity = {
      jid: this.normalizeJid(key.remoteJid) || key.remoteJid || null,
      altJid: this.normalizeJid(key.remoteJidAlt) || key.remoteJidAlt || null,
      participant: this.normalizeJid(key.participant) || key.participant || null,
      participantAlt: this.normalizeJid(key.participantAlt) || key.participantAlt || null,
      addressingMode: key.addressingMode || null,
      messageId: key.id || null,
      serverId: key.server_id || null,
      fromMe: key.fromMe === true
    };

    const candidates = [identity.participant, identity.participantAlt, identity.jid, identity.altJid];
    identity.lid = candidates.find(value => this.isLidJid(value)) || null;
    identity.phoneJid = candidates.find(value => this.isPhoneJid(value)) || null;
    identity.number = this.phoneNumberFromJid(identity.phoneJid);

    return identity;
  }

  cacheMessageIdentity(sessionId, identity) {
    const candidates = [
      identity.jid,
      identity.altJid,
      identity.participant,
      identity.participantAlt
    ].filter(Boolean);

    const lids = candidates.filter(value => this.isLidJid(value));
    const phones = candidates.filter(value => this.isPhoneJid(value));

    for (const lid of lids) {
      for (const phoneJid of phones) {
        this.cacheLidPhonePair(sessionId, lid, phoneJid);
      }
    }
  }

  getContactForIdentity(sessionId, identity) {
    const candidates = [
      identity.participant,
      identity.participantAlt,
      identity.jid,
      identity.altJid
    ];

    for (const jid of candidates) {
      const contact = this.getCachedContact(sessionId, jid);
      if (contact) return contact;
    }

    return null;
  }

  messageCacheKey(sessionId, key) {
    const messageId = key?.id;
    if (!messageId) return null;
    return `${sessionId}:${messageId}`;
  }

  cacheSentMessage(sessionId, message) {
    const key = message?.key;
    const content = message?.message;
    const cacheKey = this.messageCacheKey(sessionId, key);

    if (!cacheKey || !content) return false;

    this.sentMessageCache.set(cacheKey, {
      message: content,
      expiresAt: Date.now() + SENT_MESSAGE_CACHE_TTL_MS
    });

    return true;
  }

  getCachedMessage(sessionId, key) {
    const cacheKey = this.messageCacheKey(sessionId, key);
    if (!cacheKey) return undefined;

    const cached = this.sentMessageCache.get(cacheKey);
    if (!cached) return undefined;

    if (!cached.expiresAt || cached.expiresAt <= Date.now()) {
      this.sentMessageCache.delete(cacheKey);
      return undefined;
    }

    return cached.message;
  }

  async onMessagesUpsert(sessionId, payload) {
    if (payload?.type !== 'notify') return;

    const session = this.sessions.get(sessionId);
    const messages = payload?.messages || [];
    const meId = session?.socket?.user?.id || '';

    for (const message of messages) {
      const keyId = message?.key?.id;
      if (!keyId) continue;

      // Argumen meId tetap dikirim agar kompatibel dengan pipeline isRealMessage.
      if (!isRealMessage(message, meId)) continue;

      const identity = this.getMessageIdentity(message);
      this.cacheMessageIdentity(sessionId, identity);

      const dedupKey = `${sessionId}:in:${keyId}`;
      if (messageDeduplicator.isDuplicate(dedupKey, 24 * 60 * 60 * 1000)) continue;

      await this.safeWebhook('message.received', {
        sessionId,
        identity,
        contact: this.getContactForIdentity(sessionId, identity),
        message
      });
    }
  }

  cleanupStats() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const [sessionId, rows] of this.messageStats.entries()) {
      const filtered = rows.filter(t => now - t < oneHour);

      if (filtered.length) this.messageStats.set(sessionId, filtered);
      else this.messageStats.delete(sessionId);
    }
  }

  cleanupCaches() {
    const now = Date.now();

    for (const [key, cached] of this.jidCache.entries()) {
      if (!cached?.time || now - cached.time >= JID_CACHE_TTL_MS) {
        this.jidCache.delete(key);
      }
    }

    for (const [key, cached] of this.contactCache.entries()) {
      if (!cached?.expiresAt || cached.expiresAt <= now) {
        this.contactCache.delete(key);
      }
    }

    for (const [key, cached] of this.sentMessageCache.entries()) {
      if (!cached?.expiresAt || cached.expiresAt <= now) {
        this.sentMessageCache.delete(key);
      }
    }
  }

  assertRateLimit(sessionId) {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const rows = (this.messageStats.get(sessionId) || []).filter(t => now - t < oneHour);

    if (rows.length >= config.messageLimitPerHour) {
      throw new Error(`Message limit reached (${config.messageLimitPerHour}/hour)`);
    }

    rows.push(now);
    this.messageStats.set(sessionId, rows);
  }

  isReady(sessionId) {
    const session = this.sessions.get(sessionId);
    return Boolean(session?.socket && session.connected && session.state === SESSION_STATE.CONNECTED);
  }

  cleanNumber(number) {
    let clean = String(number || '').trim();

    if (clean.endsWith('@lid')) {
      throw new Error('LID is not a phone number');
    }

    if (clean.includes('@')) {
      clean = clean.split('@')[0];
    }

    clean = clean.replace(/\D/g, '');

    if (clean.startsWith('0')) {
      clean = `62${clean.slice(1)}`;
    }

    if (!clean.startsWith('62')) {
      clean = `62${clean}`;
    }

    if (clean.length < 10) {
      throw new Error('Invalid phone number');
    }

    return clean;
  }

  formatNumber(number) {
    return `${this.cleanNumber(number)}@s.whatsapp.net`;
  }

  parseDestination(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Destination is required');

    if (raw.endsWith('@lid')) {
      const jid = this.normalizeLidJid(raw);
      if (!jid || !/^\d+@lid$/.test(jid)) {
        throw new Error('Invalid LID');
      }

      return { type: 'lid', jid };
    }

    const number = this.cleanNumber(raw);
    return {
      type: 'phone',
      number,
      jid: `${number}@s.whatsapp.net`
    };
  }

  async checkNumber(sessionId, value) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) throw new Error('Session socket not available');

    const destination = this.parseDestination(value);

    if (destination.type === 'lid') {
      let contact = this.getCachedContact(sessionId, destination.jid);
      let phoneJid = contact?.phoneNumber || null;

      if (!phoneJid) {
        try {
          const mappedPn = await session.socket.signalRepository?.lidMapping?.getPNForLID?.(destination.jid);
          phoneJid = this.normalizePhoneJid(mappedPn);
          if (phoneJid) {
            contact = this.cacheLidPhonePair(sessionId, destination.jid, phoneJid) || contact;
          }
        } catch (error) {
          logger.warn({ err: error.message, sessionId }, 'failed to resolve PN from LID mapping store');
        }
      }

      return {
        exists: true,
        jid: destination.jid,
        lid: destination.jid,
        phoneJid,
        number: this.phoneNumberFromJid(phoneJid),
        destinationType: 'lid',
        validation: contact ? 'lid_mapping' : 'lid_direct'
      };
    }

    const cleanNumber = destination.number;
    const jid = destination.jid;
    const cachedContact = this.getCachedContact(sessionId, jid);

    if (session.number && cleanNumber === session.number) {
      return {
        exists: true,
        jid,
        lid: cachedContact?.lid || null,
        phoneJid: jid,
        number: cleanNumber,
        destinationType: 'phone',
        validation: 'self'
      };
    }

    const cacheKey = `${sessionId}:${cleanNumber}`;
    const cached = this.jidCache.get(cacheKey);

    if (cached && Date.now() - cached.time < JID_CACHE_TTL_MS) {
      const contact = this.getCachedContact(sessionId, cached.jid) || cachedContact;
      return {
        exists: true,
        jid: cached.jid,
        lid: contact?.lid || null,
        phoneJid: jid,
        number: cleanNumber,
        destinationType: 'phone',
        validation: 'jid_cache'
      };
    }

    const result = await session.socket.onWhatsApp(jid);
    const info = Array.isArray(result) ? result[0] : null;

    if (!info?.exists) {
      return {
        exists: false,
        jid,
        lid: cachedContact?.lid || null,
        phoneJid: jid,
        number: cleanNumber,
        destinationType: 'phone',
        validation: 'on_whatsapp'
      };
    }

    const finalJid = this.normalizeJid(info.jid) || jid;
    let contact = this.getCachedContact(sessionId, finalJid) || cachedContact;
    let mappedLid = contact?.lid || null;

    if (!mappedLid) {
      try {
        mappedLid = this.normalizeLidJid(
          await session.socket.signalRepository?.lidMapping?.getLIDForPN?.(jid)
        );

        if (mappedLid) {
          contact = this.cacheLidPhonePair(sessionId, mappedLid, jid) || contact;
        }
      } catch (error) {
        logger.warn({ err: error.message, sessionId }, 'failed to resolve LID from PN mapping store');
      }
    }

    this.jidCache.set(cacheKey, {
      jid: finalJid,
      time: Date.now()
    });

    return {
      exists: true,
      jid: finalJid,
      lid: mappedLid || contact?.lid || null,
      phoneJid: jid,
      number: cleanNumber,
      destinationType: 'phone',
      validation: 'on_whatsapp'
    };
  }

  async simulateTyping(socket, jid) {
    const min = Math.max(1, Number(config.typingMinSeconds || 3));
    const max = Math.max(min, Number(config.typingMaxSeconds || 8));

    await socket.presenceSubscribe(jid).catch(() => {});
    await socket.sendPresenceUpdate('composing', jid).catch(() => {});
    await sleep(randomInt(min, max) * 1000);
    await socket.sendPresenceUpdate('paused', jid).catch(() => {});
  }

  shouldSkipDuplicate(key, ttl, skipDuplicateCheck) {
    if (skipDuplicateCheck) return false;
    return messageDeduplicator.isDuplicate(key, ttl);
  }

  getSkipDuplicateFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  getContentHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  async sendMessage(sessionId, number, message, options = {}) {
    return this.runQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId);

      if (!session) throw new Error('Session not found');
      await this.assertSessionCanSend(sessionId);
      if (!this.isReady(sessionId)) throw new Error('Session not connected');
      if (!session.socket) throw new Error('Session socket not available');
      if (!number || !message) throw new Error('number and message are required');

      const messageId = options.messageId || crypto.randomUUID();
      const ttl = Number(options.deduplicationTTL || 10 * 60 * 1000);
      const skipDuplicateCheck = this.getSkipDuplicateFlag(options.skipDuplicateCheck);

      const target = await this.checkNumber(sessionId, number);

      if (!target.exists) {
        return {
          success: false,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          destinationType: target.destinationType,
          error: 'Number is not registered on WhatsApp'
        };
      }

      const dedupSource = options.messageId || `${target.jid}:${message}`;
      const dedupKey = `${sessionId}:out:text:${this.getContentHash(dedupSource)}`;

      if (this.shouldSkipDuplicate(dedupKey, ttl, skipDuplicateCheck)) {
        return {
          success: true,
          skipped: true,
          duplicate: true,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          destinationType: target.destinationType,
          reason: 'duplicate_message'
        };
      }

      this.assertRateLimit(sessionId);

      await this.waitSocketOpen(session.socket, 15000);
      await this.simulateTyping(session.socket, target.jid);
      await session.socket.sendPresenceUpdate('available').catch(() => {});

      logger.info(`[${sessionId}] kirim pesan ke ${target.jid}`);

      const result = await session.socket.sendMessage(
        target.jid,
        { text: String(message) },
        { timeoutMs: 60_000 }
      );

      const waMessageId = result?.key?.id || null;

      if (!waMessageId) {
        return {
          success: false,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          destinationType: target.destinationType,
          error: 'Message ID not returned by WhatsApp'
        };
      }

      this.cacheSentMessage(sessionId, result);

      logger.info(`[${sessionId}] pesan queued ${target.jid} waMessageId=${waMessageId}`);


      await this.safeWebhook('message.sent', {
        sessionId,
        number: target.number,
        jid: target.jid,
        lid: target.lid || null,
        phoneJid: target.phoneJid || null,
        destinationType: target.destinationType,
        messageId,
        waMessageId,
        type: 'text'
      });

      return {
        success: true,
        messageId,
        waMessageId,
        number: target.number,
        jid: target.jid,
        lid: target.lid || null,
        phoneJid: target.phoneJid || null,
        destinationType: target.destinationType,
        validation: target.validation,
        localStatus: result?.status || null
      };
    }).catch(async error => {
      if (['ACCOUNT_RESTRICTED', 'REACHOUT_TIMELOCK'].includes(error?.code)) throw error;
      await this.throwIfRestricted(sessionId, error);
      throw error;
    });
  }

  async resolveFile(fileUrl) {
    if (!fileUrl) throw new Error('fileUrl required');

    if (/^https?:\/\//i.test(fileUrl)) {
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const contentType = String(response.headers['content-type'] || '').split(';')[0];
      const urlPath = new URL(fileUrl).pathname;
      const filename = decodeURIComponent(path.basename(urlPath)) || `file-${Date.now()}`;

      return {
        buffer: Buffer.from(response.data),
        mimetype: contentType || mime.lookup(filename) || 'application/octet-stream',
        filename
      };
    }

    const filepath = path.resolve(fileUrl.startsWith('file://') ? fileURLToPath(fileUrl) : fileUrl);
    const buffer = await fsp.readFile(filepath);

    return {
      buffer,
      mimetype: mime.lookup(filepath) || 'application/octet-stream',
      filename: path.basename(filepath)
    };
  }

  mediaPayload(buffer, mimetype, filename, caption = '') {
    if (mimetype.startsWith('image/')) {
      return { image: buffer, mimetype, caption };
    }

    if (mimetype.startsWith('video/')) {
      return { video: buffer, mimetype, caption };
    }

    if (mimetype.startsWith('audio/')) {
      return { audio: buffer, mimetype, ptt: false };
    }

    return {
      document: buffer,
      mimetype,
      fileName: filename,
      caption
    };
  }

  async sendFile(sessionId, number, fileUrl, caption = '', options = {}) {
    return this.runQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId);

      if (!session) throw new Error('Session not found');
      await this.assertSessionCanSend(sessionId);
      if (!this.isReady(sessionId)) throw new Error('Session not connected');
      if (!session.socket) throw new Error('Session socket not available');
      if (!number || !fileUrl) throw new Error('number and fileUrl are required');

      const messageId = options.messageId || crypto.randomUUID();
      const ttl = Number(options.deduplicationTTL || 10 * 60 * 1000);
      const skipDuplicateCheck = this.getSkipDuplicateFlag(options.skipDuplicateCheck);

      const target = await this.checkNumber(sessionId, number);

      if (!target.exists) {
        return {
          success: false,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          destinationType: target.destinationType,
          error: 'Number is not registered on WhatsApp'
        };
      }

      const file = await this.resolveFile(fileUrl);
      const dedupSource = options.messageId || `${target.jid}:${fileUrl}:${caption}`;
      const dedupKey = `${sessionId}:out:file:${this.getContentHash(dedupSource)}`;

      if (this.shouldSkipDuplicate(dedupKey, ttl, skipDuplicateCheck)) {
        return {
          success: true,
          skipped: true,
          duplicate: true,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          destinationType: target.destinationType,
          filename: file.filename,
          mimetype: file.mimetype,
          reason: 'duplicate_file'
        };
      }

      this.assertRateLimit(sessionId);

      await this.waitSocketOpen(session.socket, 15000);
      await this.simulateTyping(session.socket, target.jid);
      await session.socket.sendPresenceUpdate('available').catch(() => {});

      logger.info(`[${sessionId}] kirim file ke ${target.jid} filename=${file.filename}`);

      const result = await session.socket.sendMessage(
        target.jid,
        this.mediaPayload(file.buffer, file.mimetype, file.filename, caption),
        { timeoutMs: 60_000 }
      );

      const waMessageId = result?.key?.id || null;

      if (!waMessageId) {
        return {
          success: false,
          messageId,
          number: target.number,
          jid: target.jid,
          lid: target.lid || null,
          phoneJid: target.phoneJid || null,
          destinationType: target.destinationType,
          filename: file.filename,
          mimetype: file.mimetype,
          error: 'Message ID not returned by WhatsApp'
        };
      }

      this.cacheSentMessage(sessionId, result);

      logger.info(`[${sessionId}] file queued ${target.jid} filename=${file.filename} waMessageId=${waMessageId}`);

      await this.safeWebhook('message.sent', {
        sessionId,
        number: target.number,
        jid: target.jid,
        lid: target.lid || null,
        phoneJid: target.phoneJid || null,
        destinationType: target.destinationType,
        messageId,
        waMessageId,
        type: 'file',
        filename: file.filename,
        mimetype: file.mimetype
      });

      return {
        success: true,
        messageId,
        filename: file.filename,
        mimetype: file.mimetype,
        waMessageId,
        number: target.number,
        jid: target.jid,
        lid: target.lid || null,
        phoneJid: target.phoneJid || null,
        destinationType: target.destinationType,
        validation: target.validation,
        localStatus: result?.status || null
      };
    }).catch(async error => {
      if (['ACCOUNT_RESTRICTED', 'REACHOUT_TIMELOCK'].includes(error?.code)) throw error;
      await this.throwIfRestricted(sessionId, error);
      throw error;
    });
  }

  async refreshProfile(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.socket?.user) return null;

    const jid = jidNormalizedUser(session.socket.user.id);

    session.number = jid?.split('@')?.[0]?.split(':')?.[0] || session.number;
    session.name = session.socket.user.name || session.socket.user.verifiedName || session.name;

    try {
      session.photo = await session.socket.profilePictureUrl(jid, 'image');
    } catch {
      session.photo = null;
    }

    return session;
  }

  getSessionInfo(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const sentLastHour = (this.messageStats.get(sessionId) || []).length;

    return {
      sessionId: session.id,
      output: session.state,
      connected: session.connected,
      restricted: session.restricted,
      restrictionCode: session.restrictionCode,
      restrictionType: session.restrictionType,
      restrictionReason: session.restrictionReason,
      restrictedAt: session.restrictedAt,
      restrictionEndsAt: session.restrictionEndsAt,
      reachoutTimeLock: session.reachoutTimeLock,
      nomor: session.number,
      nama: session.name,
      foto: session.photo,
      platform: session.platform,
      isBusiness: session.isBusiness,
      qrReady: this.qrCodes.has(sessionId),
      sentLastHour,
      limitPerHour: config.messageLimitPerHour,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastDisconnect: session.lastDisconnect
    };
  }

  listSessions() {
    return Array.from(this.sessions.keys()).map(id => this.getSessionInfo(id));
  }

  getQr(sessionId) {
    if (!this.sessions.has(sessionId)) throw new Error('Session not found');
    return this.qrCodes.get(sessionId) || null;
  }

  async deleteSession(sessionId, removeAuth = true) {
    const session = this.sessions.get(sessionId);

    this.clearRestrictionTimer(sessionId);

    if (session) {
      await this.closeSocket(session);
    }

    this.sessions.delete(sessionId);
    this.qrCodes.delete(sessionId);
    this.messageStats.delete(sessionId);

    for (const key of this.jidCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.jidCache.delete(key);
      }
    }

    for (const key of this.contactCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.contactCache.delete(key);
      }
    }

    for (const key of this.sentMessageCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.sentMessageCache.delete(key);
      }
    }

    messageDeduplicator.clearSession?.(sessionId);

    if (removeAuth) {
      await deleteAuthSession(sessionId);
    }

    return {
      success: true,
      sessionId,
      deletedAuth: removeAuth
    };
  }

  async autoRestore() {
    if (!config.autoRestoreSessions) return;

    const sessionIds = await listAuthSessionIds(config.maxSessions);

    for (const sessionId of sessionIds) {
      if (this.sessions.size >= config.maxSessions) break;

      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, this.createSessionObject(sessionId));
      }

      this.connectSession(sessionId).catch(err => {
        logger.warn({ err: err.message, sessionId }, 'auto restore failed');
      });
    }
  }
}

export default new WhatsAppService();
