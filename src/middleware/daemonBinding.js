const config = require('../config');

function enforceDaemonBinding(req, claimedAgentId) {
  if (!req.auth || !req.auth.token) {
    return null;
  }
  if (!config.daemonBindings.has(req.auth.token)) {
    return null;
  }
  const bound = config.daemonBindings.get(req.auth.token);
  if (claimedAgentId === bound) {
    return null;
  }
  return {
    status: 403,
    body: {
      error: 'DaemonBindingViolation',
      message: 'Token is not authorized to publish presence for the specified agent.'
    }
  };
}

module.exports = { enforceDaemonBinding };
