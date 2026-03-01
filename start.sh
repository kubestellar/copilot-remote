#!/bin/bash
# Copilot Remote - persistent startup script with auto-restart
DIR="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$DIR/logs"
mkdir -p "$LOGDIR"

echo "Starting Copilot Remote servers..."

# Start API server with auto-restart
(
  while true; do
    echo "[$(date)] Starting API server..." >> "$LOGDIR/server.log"
    cd "$DIR/server" && npx tsx src/index.ts >> "$LOGDIR/server.log" 2>&1
    echo "[$(date)] API server exited, restarting in 2s..." >> "$LOGDIR/server.log"
    sleep 2
  done
) &
API_PID=$!
echo "API server loop PID: $API_PID"

# Start Vite dev server with auto-restart
(
  while true; do
    echo "[$(date)] Starting Vite dev server..." >> "$LOGDIR/vite.log"
    cd "$DIR/web" && npx vite --host >> "$LOGDIR/vite.log" 2>&1
    echo "[$(date)] Vite exited, restarting in 2s..." >> "$LOGDIR/vite.log"
    sleep 2
  done
) &
VITE_PID=$!
echo "Vite server loop PID: $VITE_PID"

echo ""
echo "Both servers starting with auto-restart."
echo "API:  http://0.0.0.0:3001"
echo "Web:  http://0.0.0.0:5173"
echo "Logs: $LOGDIR/"
echo ""
echo "PIDs: $API_PID $VITE_PID" > "$LOGDIR/pids"
wait
