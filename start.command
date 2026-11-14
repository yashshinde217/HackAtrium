#!/bin/bash
# Double-click on macOS (or run ./start.command on Linux) to start the CodeCoast website.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  (open https://nodejs.org || xdg-open https://nodejs.org) >/dev/null 2>&1
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --no-audit --no-fund || { echo "npm install failed"; exit 1; }
fi

echo ""
echo "  CodeCoast is starting at http://localhost:3000"
echo "  Keep this window open while you use the site. Press Ctrl+C to stop."
echo ""
(sleep 2; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &
node server.js
