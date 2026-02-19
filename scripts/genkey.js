#!/usr/bin/env node

const crypto = require('crypto');

const key = `yaklog_${crypto.randomBytes(32).toString('hex')}`;

console.log(key);
