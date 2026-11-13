#!/usr/bin/env bash
# Test stack without Docker: a throwaway Postgres cluster and Redis server on
# the same ports as tests/stack/docker-compose.test.yaml (55432, 56379), data
# in a temp directory. For machines where Docker Desktop's VM is too heavy.
#
#   tests/stack/native-stack.sh start | stop | status
#
# Needs postgres (initdb, pg_ctl) and redis-server on PATH (brew install
# postgresql redis). Temporal is not included: the integration suite fakes
# it; the E2E suite needs the docker compose stack (or `temporal server
# start-dev --port 57233`).
set -euo pipefail

DIR="${HOOKPOST_TEST_STACK_DIR:-${TMPDIR:-/tmp}/hookpost-test-stack}"
PGDATA="$DIR/pg"
PGPORT=55432
REDISPORT=56379

start() {
  mkdir -p "$DIR"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    printf 'hookpost-test-password\n' > "$DIR/pwfile"
    initdb -D "$PGDATA" -U hookpost --pwfile="$DIR/pwfile" --auth=md5 >/dev/null
  fi
  if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/pg.log" -w start >/dev/null
  fi
  PGPASSWORD=hookpost-test-password psql -h 127.0.0.1 -p $PGPORT -U hookpost -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='hookpost_test'" | grep -q 1 ||
    PGPASSWORD=hookpost-test-password createdb -h 127.0.0.1 -p $PGPORT -U hookpost hookpost_test
  if ! redis-cli -p $REDISPORT ping >/dev/null 2>&1; then
    redis-server --port $REDISPORT --bind 127.0.0.1 --save '' --appendonly no \
      --daemonize yes --pidfile "$DIR/redis.pid" --logfile "$DIR/redis.log"
  fi
  status
}

stop() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  redis-cli -p $REDISPORT shutdown nosave >/dev/null 2>&1 || true
  echo "stopped (data kept in $DIR; rm -rf it to start clean)"
}

status() {
  pg_ctl -D "$PGDATA" status >/dev/null 2>&1 && echo "postgres: up on 127.0.0.1:$PGPORT" || echo "postgres: down"
  redis-cli -p $REDISPORT ping >/dev/null 2>&1 && echo "redis:    up on 127.0.0.1:$REDISPORT" || echo "redis:    down"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
