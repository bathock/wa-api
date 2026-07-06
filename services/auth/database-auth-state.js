import {
  BufferJSON,
  initAuthCreds,
  proto
} from '@whiskeysockets/baileys';
import database from '../../config/database.js';

const sessionWriteChains = new Map();

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(value) {
  return JSON.parse(value, BufferJSON.reviver);
}

function enqueueSessionWrite(sessionId, task) {
  const previous = sessionWriteChains.get(sessionId) || Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.finally(() => {
    if (sessionWriteChains.get(sessionId) === tracked) {
      sessionWriteChains.delete(sessionId);
    }
  });

  sessionWriteChains.set(sessionId, tracked);
  return tracked;
}

async function loadCreds(sessionId) {
  const [rows] = await database.query(
    'SELECT creds FROM wa_auth_sessions WHERE session_id = ? LIMIT 1',
    [sessionId]
  );

  if (!rows.length) return null;
  return deserialize(rows[0].creds);
}

async function saveCredsToDatabase(sessionId, creds) {
  await database.query(
    `INSERT INTO wa_auth_sessions (session_id, creds)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE
       creds = VALUES(creds),
       updated_at = CURRENT_TIMESTAMP`,
    [sessionId, serialize(creds)]
  );
}

async function getKeys(sessionId, type, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return {};

  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await database.query(
    `SELECT key_id, key_data
     FROM wa_auth_keys
     WHERE session_id = ?
       AND category = ?
       AND key_id IN (${placeholders})`,
    [sessionId, type, ...ids]
  );

  const result = {};
  for (const id of ids) result[id] = null;

  for (const row of rows) {
    let value = deserialize(row.key_data);

    if (type === 'app-state-sync-key' && value) {
      value = proto.Message.AppStateSyncKeyData.fromObject(value);
    }

    result[row.key_id] = value;
  }

  return result;
}

async function setKeys(sessionId, data) {
  return enqueueSessionWrite(sessionId, async () => {
    const connection = await database.getConnection();

    try {
      await connection.beginTransaction();

      const upserts = [];
      const deletes = [];

      for (const [category, entries] of Object.entries(data || {})) {
        for (const [keyId, value] of Object.entries(entries || {})) {
          if (value == null) {
            deletes.push([category, keyId]);
          } else {
            upserts.push([sessionId, category, keyId, serialize(value)]);
          }
        }
      }

      if (upserts.length > 0) {
        const placeholders = upserts.map(() => '(?, ?, ?, ?)').join(', ');
        const params = upserts.flat();

        await connection.query(
          `INSERT INTO wa_auth_keys (session_id, category, key_id, key_data)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             key_data = VALUES(key_data),
             updated_at = CURRENT_TIMESTAMP`,
          params
        );
      }

      for (const [category, keyId] of deletes) {
        await connection.query(
          `DELETE FROM wa_auth_keys
           WHERE session_id = ? AND category = ? AND key_id = ?`,
          [sessionId, category, keyId]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}

export async function useDatabaseAuthState(sessionId) {
  let creds = await loadCreds(sessionId);

  if (!creds) {
    creds = initAuthCreds();
    await saveCredsToDatabase(sessionId, creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => getKeys(sessionId, type, ids),
        set: data => setKeys(sessionId, data),
        clear: () => clearAuthKeys(sessionId)
      }
    },
    saveCreds: () =>
      enqueueSessionWrite(sessionId, () => saveCredsToDatabase(sessionId, creds))
  };
}


export async function ensureAuthSession(sessionId, maxSessions) {
  const connection = await database.getConnection();
  const lockName = 'wa_gateway_auth_session_limit';
  let lockAcquired = false;

  try {
    const [lockRows] = await connection.query(
      'SELECT GET_LOCK(?, 10) AS acquired',
      [lockName]
    );

    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) {
      throw new Error('Could not acquire session limit lock');
    }

    const [existingRows] = await connection.query(
      'SELECT 1 FROM wa_auth_sessions WHERE session_id = ? LIMIT 1',
      [sessionId]
    );

    if (existingRows.length > 0) {
      return { created: false, sessionId };
    }

    const [countRows] = await connection.query(
      'SELECT COUNT(*) AS total FROM wa_auth_sessions'
    );
    const total = Number(countRows[0]?.total || 0);

    if (total >= maxSessions) {
      throw new Error(`Max session reached (${maxSessions})`);
    }

    const creds = initAuthCreds();
    await connection.query(
      'INSERT INTO wa_auth_sessions (session_id, creds) VALUES (?, ?)',
      [sessionId, serialize(creds)]
    );

    return { created: true, sessionId };
  } finally {
    if (lockAcquired) {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    }
    connection.release();
  }
}

export async function authSessionExists(sessionId) {
  const [rows] = await database.query(
    'SELECT 1 FROM wa_auth_sessions WHERE session_id = ? LIMIT 1',
    [sessionId]
  );
  return rows.length > 0;
}

export async function countAuthSessions() {
  const [rows] = await database.query('SELECT COUNT(*) AS total FROM wa_auth_sessions');
  return Number(rows[0]?.total || 0);
}

export async function listAuthSessionIds(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 10_000));
  const [rows] = await database.query(
    `SELECT session_id
     FROM wa_auth_sessions
     ORDER BY created_at ASC
     LIMIT ${safeLimit}`
  );
  return rows.map(row => row.session_id);
}

export async function clearAuthKeys(sessionId) {
  return enqueueSessionWrite(sessionId, async () => {
    await database.query('DELETE FROM wa_auth_keys WHERE session_id = ?', [sessionId]);
  });
}

export async function deleteAuthSession(sessionId) {
  return enqueueSessionWrite(sessionId, async () => {
    const connection = await database.getConnection();

    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM wa_auth_keys WHERE session_id = ?', [sessionId]);
      await connection.query('DELETE FROM wa_auth_sessions WHERE session_id = ?', [sessionId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}

export const authStateCodec = {
  serialize,
  deserialize
};
