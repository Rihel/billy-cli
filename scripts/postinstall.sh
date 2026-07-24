#!/bin/sh
find node_modules/.pnpm -path '*/nestjs-trpc/native/*' -type f \
  ! -name '*.exe' ! -name '.gitkeep' \
  -exec chmod +x {} \; 2>/dev/null || true
