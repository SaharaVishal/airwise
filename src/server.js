'use strict';

const dns = require('dns');
const net = require('net');
const { createApp } = require('./app');

// Prefer IPv4 and allow slower connects: avoids ETIMEDOUT from Node's
// IPv6/IPv4 "happy eyeballs" on some hosting networks.
dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(1000);
}

const port = Number(process.env.PORT) || 8080;
const server = createApp().listen(port, () => {
  console.log(`AirWise listening on :${port}`);
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', () => server.close(() => process.exit(0)));
