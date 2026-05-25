const app = require('./app');
const config = require('./config');
const { closeDb } = require('./db');
const { startPresenceSweep, stopPresenceSweep } = require('./presenceSweep');
const { streamer: plexusStreamer } = require('./plexusStreamer');

const server = app.listen(config.port, config.host, () => {
  console.log(`yaklog listening on http://${config.host}:${config.port}`);
});

startPresenceSweep();
plexusStreamer.start();

function shutdown(signal) {
  console.log(`${signal} received, shutting down yaklog`);
  stopPresenceSweep();
  plexusStreamer.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
