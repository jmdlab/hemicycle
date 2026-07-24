#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
echo "── install (frontend) ──"; npm install --silent
echo "── install (server) ──";   (cd server && npm install --silent)
echo "── build ──";              npm run build
echo "── restart backend ──";    sudo systemctl restart hemicycle.service
sleep 1; systemctl --no-pager --lines=0 status hemicycle.service | head -4
echo "── reload nginx ──";       sudo nginx -t && sudo systemctl reload nginx
echo "── smoke ──";              curl -sf http://127.0.0.1:3206/api/hemicycle/health && echo
echo "OK — https://hemicycle.app/"
