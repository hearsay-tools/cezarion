#!/bin/sh
exec env -u TMP -u TEMP TMPDIR=/tmp /home/agent/.cache/agent-tools/agent-browser/agent-browser-linux-x64 --session "${RUNTIME_BROWSER_SESSION:-runtime-e2fa-short}" --args '--no-sandbox' "$@"
