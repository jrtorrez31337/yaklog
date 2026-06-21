// CP16-prep observability migration: GET /api/v1/metrics endpoint per parch #10166
// ratify of Option 2c. Mounted via app.use('/api/v1/metrics', auth, ...) so the
// global auth middleware applies (per secops #10164 corrected Q2: yaklog:3100 is
// host-public; auth REQUIRED). Prometheus scrape config (in plexus-prometheus's
// prometheus.yml) provides a scoped bearer per ssw-devops Gate (2) install work.
//
// Returns Prom text-format from the custom Registry in ./metrics — NOT the
// default-collector Registry per secops Gate (1) condition.

'use strict';

const express = require('express');
const { registry } = require('./metrics');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const body = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    return res.status(200).send(body);
  } catch (e) {
    return res.status(500).json({
      error: 'InternalError',
      message: `metrics serialization failed: ${e.message}`,
    });
  }
});

module.exports = router;
