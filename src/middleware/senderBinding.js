const config = require('../config');

function enforceSenderBinding(req, claimedSender) {
  if (!req.auth || !req.auth.token) {
    return null;
  }
  if (!config.tokenBindings.has(req.auth.token)) {
    return null;
  }
  const bound = config.tokenBindings.get(req.auth.token);
  if (claimedSender === bound) {
    return null;
  }
  return {
    status: 403,
    body: {
      error: 'SenderBindingViolation',
      message: 'Token is not authorized for the specified sender.'
    }
  };
}

function enforceMutationBinding(req, originalSender) {
  if (!req.auth || !req.auth.token) {
    return null;
  }
  if (!config.tokenBindings.has(req.auth.token)) {
    return null;
  }
  const bound = config.tokenBindings.get(req.auth.token);
  if (originalSender === bound) {
    return null;
  }
  return {
    status: 403,
    body: {
      error: 'SenderBindingViolation',
      message: 'Token is not authorized to modify this message.'
    }
  };
}

module.exports = {
  enforceSenderBinding,
  enforceMutationBinding
};
