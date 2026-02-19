const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('./config');

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

function toMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    sender: row.sender,
    body: row.body,
    metadata: parseMetadata(row.metadata_json),
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

  return db;
}

function getDb() {
  return db || initializeDb();
}

function insertMessage({ channel, sender, body, metadata = null }) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO messages (channel, sender, body, metadata_json)
    VALUES (@channel, @sender, @body, @metadata_json)
  `);

  const result = stmt.run({
    channel,
    sender,
    body,
    metadata_json: metadata ? JSON.stringify(metadata) : null
  });

  const row = database
    .prepare('SELECT id, channel, sender, body, metadata_json, created_at FROM messages WHERE id = ?')
    .get(result.lastInsertRowid);

  return toMessage(row);
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
      SELECT id, channel, sender, body, metadata_json, created_at
      FROM messages
      ${whereSql}
      ORDER BY id DESC
      LIMIT @limit
    `)
    .all(params);

  return rows.reverse().map(toMessage);
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
    .prepare('SELECT id, channel, sender, body, metadata_json, created_at, updated_at FROM messages WHERE id = ?')
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

module.exports = {
  initializeDb,
  insertMessage,
  listMessages,
  listChannels,
  getMessage,
  updateMessage,
  deleteMessage,
  closeDb
};
