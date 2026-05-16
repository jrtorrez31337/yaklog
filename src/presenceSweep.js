const { expireStalePresence } = require('./db');
const config = require('./config');

let timer = null;

function startPresenceSweep() {
  if (timer) return timer;
  if (config.presenceSweepIntervalMs <= 0) return null;
  timer = setInterval(() => {
    try {
      const expired = expireStalePresence(config.presenceTtlSeconds);
      if (expired.length > 0) {
        console.log(`[presence] TTL expired ${expired.length} agent(s) → daemon_state=down: ${expired.join(', ')}`);
      }
    } catch (err) {
      console.error('[presence] sweep error:', err);
    }
  }, config.presenceSweepIntervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stopPresenceSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startPresenceSweep, stopPresenceSweep };
