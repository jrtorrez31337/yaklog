const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const auth = require('./middleware/auth');
const { initializeDb } = require('./db');

initializeDb();

const app = express();

app.use(helmet());

const corsOptions = {
  origin: config.corsOrigin === '*'
    ? true
    : config.corsOrigin
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
};

app.use(cors(corsOptions));
app.use(compression());
app.use(morgan(config.isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: config.maxBodyBytes }));

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'yaklog' });
});

app.use('/api/v1', auth, routes);

app.get('/', (req, res) => {
  res.json({
    name: 'yaklog',
    version: '0.1.0',
    purpose: 'Internal coordination log for Claude/Codex sessions.',
    health: '/api/v1/health',
    api_base: '/api/v1'
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'NotFound', message: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'InternalServerError', message: 'Unexpected server error.' });
});

module.exports = app;
