#!/bin/sh
exec env -u TMP -u TEMP TMPDIR=/tmp /home/agent/.cache/agent-tools/agent-browser/agent-browser-linux-x64 --session git5653 --args '--no-sandbox' "$@"
