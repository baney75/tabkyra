#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

case "$1" in
dev)
    echo "Starting dev server at http://localhost:8080"
    npx vite --config infra/vite.config.ts
    ;;

build)
    echo "Building static site..."
    npx vite build --config infra/vite.config.ts
    echo "Done. Output in dist/"
    ;;

*)
    echo "Usage: $0 {dev|build}"
    exit 1
    ;;
esac
