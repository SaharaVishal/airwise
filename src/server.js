'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 8080;
const server = createApp().listen(port, () => {
  console.log(`AirWise listening on :${port}`);
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => server.close(() => process.exit(0)));
