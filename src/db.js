const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');

const config = require('./config');
const { parseMentions } = require('./mentions');

const messageBus = new EventEmitter();
messageBus.setMaxListeners(0);

let db;

function parseMetadata(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseMentionsField(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toMessage(row) {
  return {
    id: row.id,
    seq: row.id,
    channel: row.channel,
    sender: row.sender,
    body: row.body,
    metadata: parseMetadata(row.metadata_json),
    mentions: parseMentionsField(row.mentions),
    created_at: row.created_at,
    updated_at: row.updated_at || null
  };
}

function initializeDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN updated_at TEXT`);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN mentions TEXT`);
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      throw err;
    }
  }

  const rowsToBackfill = db
    .prepare('SELECT id, body FROM messages WHERE mentions IS NULL')
    .all();
  if (rowsToBackfill.length > 0) {
    const updateBackfill = db.prepare('UPDATE messages SET mentions = ? WHERE id = ?');
    const runBackfill = db.transaction((rows) => {
      for (const row of rows) {
        updateBackfill.run(JSON.stringify(parseMentions(row.body)), row.id);
      }
    });
    runBackfill(rowsToBackfill);
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS presence (
      agent_id              TEXT PRIMARY KEY,
      daemon_state          TEXT NOT NULL CHECK (daemon_state IN ('up','down')),
      session_state         TEXT NOT NULL CHECK (session_state IN ('active','idle','unknown','tool_running','idle_between_tools')),
      cursor_position       INTEGER,
      lock_held             INTEGER NOT NULL DEFAULT 0,
      sse_connected         INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at     TEXT NOT NULL,
      last_hook_at          TEXT,
      last_state_change_at  TEXT NOT NULL
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS presence_transitions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id              TEXT NOT NULL,
      from_label            TEXT,
      to_label              TEXT NOT NULL,
      occurred_at           TEXT NOT NULL,
      reason                TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_transitions_agent_time ON presence_transitions(agent_id, occurred_at DESC)`).run();

  return db;
}

function getDb() {
  return db || initializeDb();
}

function insertMessage({ channel, sender, body, metadata = null }) {
  const database = getDb();
  const mentions = parseMentions(body);
  const stmt = database.prepare(`
    INSERT INTO messages (channel, sender, body, metadata_json, mentions)
    VALUES (@channel, @sender, @body, @metadata_json, @mentions)
  `);

  const result = stmt.run({
    channel,
    sender,
    body,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    mentions: JSON.stringify(mentions)
  });

  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at FROM messages WHERE id = ?')
    .get(result.lastInsertRowid);

  const message = toMessage(row);
  messageBus.emit('message', message);
  return message;
}

function listMessages({ channel, limit = 50, afterId = null, beforeId = null }) {
  const database = getDb();
  const where = [];
  const params = { limit };

  if (channel) {
    where.push('channel = @channel');
    params.channel = channel;
  }

  if (afterId !== null) {
    where.push('id > @afterId');
    params.afterId = afterId;
  }

  if (beforeId !== null) {
    where.push('id < @beforeId');
    params.beforeId = beforeId;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = database
    .prepare(`
      SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at
      FROM messages
      ${whereSql}
      ORDER BY id DESC
      LIMIT @limit
    `)
    .all(params);

  return rows.reverse().map(toMessage);
}

function listMessagesAfter({ afterId, channel, excludeSender, mentions }) {
  const database = getDb();
  const where = ['id > @afterId'];
  const params = { afterId };
  if (channel) { where.push('channel = @channel'); params.channel = channel; }
  if (excludeSender) { where.push('sender != @excludeSender'); params.excludeSender = excludeSender; }
  const rows = database
    .prepare(`SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at
              FROM messages
              WHERE ${where.join(' AND ')}
              ORDER BY id ASC`)
    .all(params);
  const filtered = rows.map(toMessage).filter((m) => {
    if (!mentions || mentions.length === 0) return true;
    const msgMentions = m.mentions || [];
    return mentions.some((mention) => msgMentions.includes(mention));
  });
  return filtered;
}

function listChannels(limit = 100) {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        channel,
        COUNT(*) AS message_count,
        MAX(id) AS latest_id,
        MAX(created_at) AS last_message_at
      FROM messages
      GROUP BY channel
      ORDER BY latest_id DESC
      LIMIT ?
    `)
    .all(limit);
}

function getMessage(id) {
  const database = getDb();
  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, mentions, created_at, updated_at FROM messages WHERE id = ?')
    .get(id);
  return row ? toMessage(row) : null;
}

function updateMessage(id, { body, metadata } = {}) {
  const database = getDb();
  const sets = [];
  const params = { id };

  if (body !== undefined) {
    sets.push('body = @body');
    params.body = body;
    sets.push('mentions = @mentions');
    params.mentions = JSON.stringify(parseMentions(body));
  }

  if (metadata !== undefined) {
    sets.push('metadata_json = @metadata_json');
    params.metadata_json = metadata ? JSON.stringify(metadata) : null;
  }

  if (sets.length === 0) {
    return null;
  }

  sets.push("updated_at = datetime('now')");

  const result = database
    .prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);

  if (result.changes === 0) {
    return null;
  }

  return getMessage(id);
}

function deleteMessage(id) {
  const database = getDb();
  const result = database.prepare('DELETE FROM messages WHERE id = ?').run(id);
  return result.changes > 0;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

const PRESENCE_LABELS = {
  up: { active: 'online', idle: 'online_idle', unknown: 'stalled', tool_running: 'online_tool_running', idle_between_tools: 'online_idle_between_tools' },
  down: { active: 'offline', idle: 'offline', unknown: 'offline', tool_running: 'offline', idle_between_tools: 'offline' }
};

function deriveLabel(daemon_state, session_state) {
  return (PRESENCE_LABELS[daemon_state] || {})[session_state] || 'offline';
}

function upsertPresence({ agent_id, daemon_state, session_state, cursor_position, lock_held, sse_connected, last_hook_at, reason }) {
  const database = getDb();
  const now = new Date().toISOString();
  const newLabel = deriveLabel(daemon_state, session_state);

  const existing = database.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agent_id);
  const oldLabel = existing ? deriveLabel(existing.daemon_state, existing.session_state) : null;
  const stateChanged = !existing
    || existing.daemon_state !== daemon_state
    || existing.session_state !== session_state;

  const last_state_change_at = stateChanged ? now : (existing ? existing.last_state_change_at : now);

  const stmt = database.prepare(`
    INSERT INTO presence (agent_id, daemon_state, session_state, cursor_position, lock_held, sse_connected, last_heartbeat_at, last_hook_at, last_state_change_at)
    VALUES (@agent_id, @daemon_state, @session_state, @cursor_position, @lock_held, @sse_connected, @last_heartbeat_at, @last_hook_at, @last_state_change_at)
    ON CONFLICT(agent_id) DO UPDATE SET
      daemon_state = excluded.daemon_state,
      session_state = excluded.session_state,
      cursor_position = excluded.cursor_position,
      lock_held = excluded.lock_held,
      sse_connected = excluded.sse_connected,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_hook_at = COALESCE(excluded.last_hook_at, presence.last_hook_at),
      last_state_change_at = excluded.last_state_change_at
  `);
  stmt.run({
    agent_id,
    daemon_state,
    session_state,
    cursor_position: cursor_position ?? null,
    lock_held: lock_held ? 1 : 0,
    sse_connected: sse_connected ? 1 : 0,
    last_heartbeat_at: now,
    last_hook_at: last_hook_at ?? null,
    last_state_change_at
  });

  if (stateChanged) {
    database.prepare('INSERT INTO presence_transitions (agent_id, from_label, to_label, occurred_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(agent_id, oldLabel, newLabel, now, reason ?? null);
  }
  return getPresenceByAgent(agent_id);
}

function getPresenceByAgent(agent_id) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agent_id);
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    daemon_state: row.daemon_state,
    session_state: row.session_state,
    label: deriveLabel(row.daemon_state, row.session_state),
    cursor_position: row.cursor_position,
    lock_held: !!row.lock_held,
    sse_connected: !!row.sse_connected,
    last_heartbeat_at: row.last_heartbeat_at,
    last_hook_at: row.last_hook_at,
    last_state_change_at: row.last_state_change_at
  };
}

function listPresence() {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM presence ORDER BY agent_id ASC').all();
  return rows.map((row) => ({
    agent_id: row.agent_id,
    daemon_state: row.daemon_state,
    session_state: row.session_state,
    label: deriveLabel(row.daemon_state, row.session_state),
    cursor_position: row.cursor_position,
    lock_held: !!row.lock_held,
    sse_connected: !!row.sse_connected,
    last_heartbeat_at: row.last_heartbeat_at,
    last_hook_at: row.last_hook_at,
    last_state_change_at: row.last_state_change_at
  }));
}

function listPresenceTransitions(agent_id, limit = 50) {
  const database = getDb();
  const rows = database
    .prepare('SELECT id, from_label, to_label, occurred_at, reason FROM presence_transitions WHERE agent_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .all(agent_id, limit);
  return rows;
}

function expireStalePresence(ttlSeconds) {
  const database = getDb();
  const cutoffIso = new Date(Date.now() - ttlSeconds * 1000).toISOString();
  const stale = database
    .prepare(`SELECT agent_id, daemon_state, session_state FROM presence WHERE daemon_state = 'up' AND last_heartbeat_at < ?`)
    .all(cutoffIso);
  if (stale.length === 0) return [];
  const now = new Date().toISOString();
  const flipDaemon = database.prepare(`UPDATE presence SET daemon_state = 'down', last_state_change_at = ? WHERE agent_id = ?`);
  const recordTransition = database.prepare('INSERT INTO presence_transitions (agent_id, from_label, to_label, occurred_at, reason) VALUES (?, ?, ?, ?, ?)');
  const tx = database.transaction((rows) => {
    for (const row of rows) {
      const fromLabel = deriveLabel(row.daemon_state, row.session_state);
      const toLabel = deriveLabel('down', row.session_state);
      flipDaemon.run(now, row.agent_id);
      recordTransition.run(row.agent_id, fromLabel, toLabel, now, `ttl_expired_${ttlSeconds}s`);
    }
  });
  tx(stale);
  return stale.map((r) => r.agent_id);
}

module.exports = {
  initializeDb,
  insertMessage,
  listMessages,
  listMessagesAfter,
  listChannels,
  getMessage,
  updateMessage,
  deleteMessage,
  upsertPresence,
  getPresenceByAgent,
  listPresence,
  listPresenceTransitions,
  expireStalePresence,
  deriveLabel,
  closeDb,
  messageBus
};
