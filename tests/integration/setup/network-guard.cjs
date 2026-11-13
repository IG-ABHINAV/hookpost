/**
 * Refuses every outbound connection that is not to this machine, so the
 * integration and E2E backends cannot reach a real service (Resend, Google,
 * OpenAI, a social network) and pass or fail because of it.
 *
 * Every Node client ends in net.Socket.prototype.connect: http/https and their
 * agents, tls, the global fetch (undici), ioredis. Prisma's engine is native
 * and only talks to the local test database. A refused connection fails like
 * a closed port (ECONNREFUSED) and is recorded; the integration suite fails
 * the test that caused it (after-env.ts), the E2E backend serves the list on
 * its control port (GET /network) and Playwright's teardown fails the run.
 *
 * Installed once per process; the record is kept on the net module, which is
 * the same object in every jest test file of a worker.
 */
const net = require('net');

const KEY = '__hookpostNetworkGuard';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1']);

const isLocal = (host) => {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || /^127\./.test(h);
};

/** {host, port} for a TCP connect, or null for a unix socket / pipe. */
function targetOf(args) {
  // net.connect() hands connect() its already-normalised [options, cb].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return { host: first.host || 'localhost', port: first.port };
  }
  if (typeof first === 'number' || /^\d+$/.test(String(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  }
  return null; // a path
}

function install() {
  if (net[KEY]) return net[KEY];
  const state = { blocked: [] };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args);
    if (target && !isLocal(target.host)) {
      const where = `${target.host}:${target.port}`;
      state.blocked.push({ where, at: new Date().toISOString(), stack: new Error().stack });
      const err = new Error(
        `network guard: refused an outbound connection to ${where}; tests talk only to localhost (tests/integration/setup/network-guard.cjs)`
      );
      err.code = 'ECONNREFUSED';
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  };
  net[KEY] = state;
  return state;
}

/** Connections refused since the last call, and forgets them. */
function takeBlocked() {
  const state = net[KEY];
  return state ? state.blocked.splice(0) : [];
}

module.exports = { install, takeBlocked, isLocal };
