#!/bin/bash
# Antigravity Mobile Stop Script - macOS/Linux
# Make executable: chmod +x Stop-Antigravity-Mobile.sh

echo ""
echo "=========================================="
echo "  Stopping Antigravity Mobile Server"
echo "=========================================="
echo ""

PORT=3001
PID=""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - use lsof
    PID=$(lsof -ti :$PORT 2>/dev/null)
else
    # Linux - try multiple methods
    if command -v lsof &> /dev/null; then
        PID=$(lsof -ti :$PORT 2>/dev/null)
    elif command -v fuser &> /dev/null; then
        PID=$(fuser $PORT/tcp 2>/dev/null)
    elif command -v ss &> /dev/null; then
        # Extract PID using awk instead of grep -P
        PID=$(ss -tlnp 2>/dev/null | awk -v port=":$PORT " '$0 ~ port {match($0, /pid=[0-9]+/); print substr($0, RSTART+4, RLENGTH-4)}')
    fi
fi

if [ -n "$PID" ]; then
    echo "Found server process with PID: $PID"
    kill -9 $PID 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "Server stopped successfully!"
    else
        echo "Failed to stop process $PID"
        echo "You may need to run with sudo: sudo ./Stop-Antigravity-Mobile.sh"
    fi
else
    echo "No server found running on port $PORT."
fi

echo ""
