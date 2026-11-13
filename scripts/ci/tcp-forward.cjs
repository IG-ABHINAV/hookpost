#!/usr/bin/env node
/**
 * Forwards local ports to the test services Cloud Build runs as sibling
 * containers, so the integration and E2E suites keep connecting to 127.0.0.1
 * (their network guard refuses every other host):
 *
 *   127.0.0.1:55432 -> postgres:5432   (HOOKPOST_TEST_DATABASE_URL, HOOKPOST_E2E_DATABASE_URL)
 *   127.0.0.1:56379 -> redis:6379      (HOOKPOST_TEST_REDIS_URL)
 *
 * Same ports as tests/stack/docker-compose.test.yaml. Started in the
 * background by cloudbuild.tests.yaml; exits with the step. Not for laptops,
 * where the compose stack publishes these ports itself.
 */
const net = require('node:net');

const ROUTES = [
  [55432, 'postgres', 5432],
  [56379, 'redis', 6379],
];

for (const [localPort, host, port] of ROUTES) {
  net
    .createServer((client) => {
      const upstream = net.connect(port, host);
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    })
    .listen(localPort, '127.0.0.1', () => console.log(`tcp-forward: 127.0.0.1:${localPort} -> ${host}:${port}`));
}
