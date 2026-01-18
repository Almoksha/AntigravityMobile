#!/bin/bash
# Antigravity Mobile Launcher - macOS/Linux
# Make executable: chmod +x Start-Antigravity-Mobile.sh

cd "$(dirname "$0")"

echo ""
echo "=========================================="
echo "  Antigravity Mobile Server"
echo "=========================================="
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org/"
    echo "Or use your package manager:"
    echo "  macOS:  brew install node"
    echo "  Ubuntu: sudo apt install nodejs npm"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "First time setup - Installing dependencies..."
    echo "This may take a minute..."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "ERROR: Failed to install dependencies!"
        exit 1
    fi
    echo ""
    echo "Dependencies installed successfully!"
    echo ""
fi

echo "Starting server..."
echo ""
node launcher.mjs
