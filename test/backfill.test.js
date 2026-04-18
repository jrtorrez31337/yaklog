const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

test('initializeDb backfills mentions for pre-existing rows without mentions column', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-backfill-'));
  const dbPath = path.join(tempDir, 'yaklog.db');

  // Seed a DB that looks like pre-yakchat: no mentions column, some rows.
  const seed = new Database(dbPath);
  const createSql = `
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
  seed.prepare(createSql).run();
  const insert = seed.prepare('INSERT INTO messages (channel, sender, body) VALUES (?, ?, ?)');
  for (let i = 0; i < 50; i++) {
    insert.run('legacy', 'agent', `msg ${i} @alice and @bob-${i}`);
  }
  seed.close();

  process.env.YAKLOG_DB_PATH = dbPath;
  process.env.YAKLOG_API_KEYS = 'test-key';
  process.env.NODE_ENV = 'test';

  delete require.cache[require.resolve('../src/db')];
  const { initializeDb, closeDb } = require('../src/db');
  initializeDb();

  const verify = new Database(dbPath, { readonly: true });
  const nullCount = verify.prepare('SELECT COUNT(*) AS c FROM messages WHERE mentions IS NULL').get().c;
  assert.equal(nullCount, 0, 'all rows should have been backfilled');

  const sample = verify.prepare('SELECT mentions FROM messages WHERE id = 1').get();
  assert.deepEqual(JSON.parse(sample.mentions), ['alice', 'bob-0']);
  verify.close();

  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
