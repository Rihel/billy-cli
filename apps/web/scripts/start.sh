#!/bin/sh
set -e

STANDALONE=.next/standalone/apps/web

cp -r .next/static "$STANDALONE/.next/static"
cp -r public "$STANDALONE/public" 2>/dev/null || true

exec PORT=9845 node "$STANDALONE/server.js"
