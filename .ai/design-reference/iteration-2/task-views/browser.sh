#!/bin/sh
exec env -u TMP -u TEMP TMPDIR=/tmp /home/agent/.cache/agent-tools/agent-browser/agent-browser-linux-x64 --session task-views-445 --args '--no-sandbox' "$@"
