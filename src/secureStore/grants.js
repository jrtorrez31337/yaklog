// Task #138 Phase 2A grants resolver per parch #10320 ratify + secops #10296.
// Reads + decrypts grants.sops.json at request-time (no caching per OQ-3 ratify
// "no caching (secops-strict)" at #10249). Returns granted vendors for a
// given agent_id per the auth table shape:
//
//   {
//     "version": "1.0",
//     "grants": [
//       { "agent_id": "ptah-test-1", "vendors": ["openai"], "note": "..." },
//       ...
//     ]
//   }
//
// Per parch #10240 Cond 3 ratify: fail-closed on missing grant. Per secops
// #10249 Cond 3 PASS: deny-by-default discipline.

'use strict';

const { decryptGrants } = require('./sopsAge');

// Returns array of granted vendor names for agent_id, or [] if no grants.
// Never throws on missing-grant (just returns []); only throws on
// substrate failure (sops decrypt fail, malformed grants).
function getGrantedVendorsForAgent(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) return [];
  const grants = decryptGrants();
  if (!grants || !Array.isArray(grants.grants)) return [];
  const out = new Set();
  for (const row of grants.grants) {
    if (!row || row.agent_id !== agentId) continue;
    if (!Array.isArray(row.vendors)) continue;
    for (const v of row.vendors) {
      if (typeof v === 'string' && v.length > 0) out.add(v);
    }
  }
  return [...out];
}

module.exports = {
  getGrantedVendorsForAgent,
};
