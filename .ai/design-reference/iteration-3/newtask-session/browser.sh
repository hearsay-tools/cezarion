#!/bin/sh
exec env -u TMP -u TEMP TMPDIR=/tmp /home/agent/.cache/agent-tools/agent-browser/agent-browser-linux-x64 --session newtask-session-06 --args '--no-sandbox' "$@"
