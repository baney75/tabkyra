#!/bin/bash

# Watch-build the Tabkyra extension and the landing site.
# Usage: ./dev.sh

set -e

trap 'echo ""; echo "Stopping dev servers..."; kill 0' EXIT INT TERM

echo "Starting Tabkyra extension watcher..."
npm run dev &

echo "Starting Tabkyra site dev server..."
(cd site && ./run.sh dev) &

echo ""
echo "  extension: watching, output in dist-chrome/"
echo "  site: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop"

wait
