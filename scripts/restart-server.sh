#!/bin/sh
# Restarts the dev server for Country Explorer, so it never has to be asked for by hand.
#
#   sh scripts/restart-server.sh              # http://localhost:8420/  (the port README.md and playwright.config.js use)
#   PORT=8500 sh scripts/restart-server.sh    # another port, leaving 8420 alone
#   npm run restart-server                    # the same as the first line
#
# What it does:
#   1. Stops whatever `python3 -m http.server` is holding the port. Several projects share port 8420, so the
#      server found there is often another project's: the script says which folder it was serving, so you can
#      start that one again (on another port) if you still need it. Anything on the port that is NOT a python
#      http.server (a database, an app...) is left alone — the script says so and stops.
#   2. Starts a fresh `python3 -m http.server` from THIS project's folder, detached from the terminal, logging
#      to a temp file.
#   3. Waits until http://localhost:PORT/ answers with this project's page, then prints the address.
#
# Safe to run at any time, as often as you like.

set -eu

PORT="${PORT:-8420}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR="${TMPDIR:-/tmp}"
LOG="${TEMP_DIR%/}/country-explorer-server-$PORT.log"
READY_ATTEMPTS=50 # x 0.1 s

fail() {
  echo "restart-server: $*" >&2
  exit 1
}

case "$PORT" in
  '' | *[!0-9]*) fail "PORT must be a number, not '$PORT'" ;;
esac
for tool in lsof python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "needs '$tool' (not found on PATH)"
done

# ---- 1. free the port ------------------------------------------------------------------------------------------

for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$command_line" in
    *http.server*) ;;
    *) fail "port $PORT is held by something other than a python http.server (pid $pid: $command_line). Not touching it — free the port yourself, or run with PORT=<another port>." ;;
  esac
  folder="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  echo "Stopping the http.server on port $PORT (pid $pid, serving ${folder:-an unknown folder})"
  kill "$pid" 2>/dev/null || fail "could not stop pid $pid (is it someone else's?)"
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 30 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
done

# ---- 2. start a fresh one from this folder ----------------------------------------------------------------------

cd "$ROOT"
nohup python3 -m http.server "$PORT" >"$LOG" 2>&1 &
new_pid=$!

# ---- 3. wait until it is really serving THIS project ------------------------------------------------------------

attempts=0
until curl -fs "http://localhost:$PORT/index.html" 2>/dev/null | grep -q '<title>Country Explorer</title>'; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt "$READY_ATTEMPTS" ] || ! kill -0 "$new_pid" 2>/dev/null; then
    echo "restart-server: the server did not come up on port $PORT. Its log ($LOG):" >&2
    tail -n 20 "$LOG" >&2 || true
    exit 1
  fi
  sleep 0.1
done

echo "Country Explorer is being served at http://localhost:$PORT/  (pid $new_pid, folder $ROOT)"
echo "Log: $LOG"
