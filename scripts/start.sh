#!/usr/bin/env bash
# Production entrypoint (Dockerfile): migrate, then run the web server and the worker side by side.
# If either exits, stop the other and exit non-zero so the platform restarts the container; an
# import in flight resumes on restart (see "Scale strategy" in the README).
set -euo pipefail

bun run db:migrate

bun run worker &
worker=$!
bun run serve &
web=$!

trap 'kill "$worker" "$web" 2>/dev/null || true' TERM INT
wait -n "$worker" "$web"
status=$?
kill "$worker" "$web" 2>/dev/null || true
exit "$((status == 0 ? 1 : status))"
