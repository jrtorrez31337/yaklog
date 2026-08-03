// Task #138 Phase 2A vendor-key delivery substrate per PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE.md §5
// + parch #10320 Cond-2 substrate-prep ratify + OQ-2(a) subprocess sops --decrypt
// + secops #10296 shape (B) separate-as-planned + secops #10319 .sops.env naming canon.
//
// Wraps `sops --decrypt` subprocess. age-private-key mounted at
// /etc/yaklog/yaklog-runtime.age.key (per ssw-devops #10288 OOB ferry; per
// docker-compose volumes block to be added at Phase 2 mount). SOPS_AGE_KEY_FILE
// env var points sops at the mounted key during decrypt invocation.
//
// Decrypted plaintext NEVER persists — handler holds plaintext only in request-
// scoped memory; never written to DB, log, or stdout. Secrets discipline per
// [[feedback_secrets_no_yaklog]] + [[feedback_precision_probe_credential_discipline]].
//
// Test mode: setMockDecrypt() allows tests to inject a synthetic decrypt
// function avoiding sops subprocess dependency. Production path uses
// child_process.spawnSync.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_AGE_KEY_PATH = process.env.YAKLOG_RUNTIME_AGE_KEY ||
  '/etc/yaklog/yaklog-runtime.age.key';
const DEFAULT_SWARM_SECRETS_DIR = process.env.YAKLOG_SWARM_SECRETS_DIR ||
  '/srv/git/swarm-secrets/vendor-keys';
const SOPS_TIMEOUT_MS = 5000;

let mockDecrypt = null;

function setMockDecrypt(fn) { mockDecrypt = fn; }
function clearMockDecrypt() { mockDecrypt = null; }

// Decrypt a sops-encrypted file at the given path. Returns the cleartext
// string on success; throws on failure. Cleartext is never logged.
function decryptFile(filePath) {
  if (mockDecrypt) return mockDecrypt(filePath);

  if (!fs.existsSync(filePath)) {
    const err = new Error(`sops file not found: ${path.basename(filePath)}`);
    err.code = 'ENOENT';
    throw err;
  }
  if (!fs.existsSync(DEFAULT_AGE_KEY_PATH)) {
    const err = new Error('age key not mounted at runtime path');
    err.code = 'EKEYMISSING';
    throw err;
  }

  const result = spawnSync('sops', ['--decrypt', filePath], {
    env: {
      ...process.env,
      SOPS_AGE_KEY_FILE: DEFAULT_AGE_KEY_PATH,
    },
    encoding: 'utf-8',
    timeout: SOPS_TIMEOUT_MS,
  });

  if (result.error) {
    const err = new Error(`sops invocation failed: ${result.error.code || result.error.message}`);
    err.code = 'ESOPSFAIL';
    throw err;
  }
  if (result.status !== 0) {
    // Truncate stderr; never include the source file content
    const stderrSnippet = (result.stderr || '').toString().slice(0, 200);
    const err = new Error(`sops decrypt exit ${result.status}: ${stderrSnippet}`);
    err.code = 'EDECRYPT';
    throw err;
  }
  return result.stdout;
}

// Parse dotenv-formatted cleartext into {KEY: VALUE} object.
// Per secops #10319: openai.sops.env decrypts to `OPENAI_API_KEY=sk-...` shape.
// Minimal parser — no shell expansion, no quotes interpretation (keeps simple).
function parseDotEnv(text) {
  const result = {};
  if (!text) return result;
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// Decrypt + parse a per-vendor .sops.env file. Returns {KEY: VALUE} map.
function decryptVendorKey(vendor) {
  if (typeof vendor !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(vendor)) {
    const err = new Error('vendor must match [a-z][a-z0-9-]{0,30}');
    err.code = 'EBADVENDOR';
    throw err;
  }
  const filePath = path.join(DEFAULT_SWARM_SECRETS_DIR, `${vendor}.sops.env`);
  const cleartext = decryptFile(filePath);
  return parseDotEnv(cleartext);
}

// Decrypt grants table. Returns parsed JSON object.
function decryptGrants() {
  const filePath = path.join(DEFAULT_SWARM_SECRETS_DIR, 'grants.sops.json');
  const cleartext = decryptFile(filePath);
  try {
    return JSON.parse(cleartext);
  } catch (e) {
    const err = new Error('grants.sops.json content not valid JSON');
    err.code = 'EGRANTSPARSE';
    throw err;
  }
}

module.exports = {
  decryptFile,
  decryptVendorKey,
  decryptGrants,
  parseDotEnv,
  setMockDecrypt,
  clearMockDecrypt,
  _internals: { DEFAULT_AGE_KEY_PATH, DEFAULT_SWARM_SECRETS_DIR },
};
