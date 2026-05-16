const config = require('../config');

function enforceSenderBinding(req, claimedSender) {
  if (!req.auth || !req.auth.token) {
    return null;
  }
  const allowedSenders = config.tokenBindings.get(req.auth.token);
  if (!allowedSenders) {
    return null;
  }
  if (allowedSenders.has(claimedSender)) {
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
  const allowedSenders = config.tokenBindings.get(req.auth.token);
  if (!allowedSenders) {
    return null;
  }
  if (allowedSenders.has(originalSender)) {
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
