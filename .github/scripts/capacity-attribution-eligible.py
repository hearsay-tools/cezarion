"""Select a failed capacity result without exposing runtime evidence."""
import json
from pathlib import Path
import re
import sys

LIMIT = 8 * 1024 * 1024
MARKER = 'capacity result: '
RESOURCES = {'process', 'worktree', 'branch'}
SUFFIX = re.compile(r', [0-9]+ reaper calls, [0-9]+ ms(?:\r?\n|$)')
TRACEBACK = b'Traceback (most recent call last):'
FRAME = re.compile(r'^  File "(/[^"\x00\r\n]*/\.github/scripts/linux-mount-alias-probe\.py)", line (409|400|351), in (?:<module>|main|run_probe)$')


def terminal_traceback(lines):
    # Deliberately tied to the supervisor pinned in capacity-attribution-auth.ts.
    if len(lines) != 8 or lines[0] != TRACEBACK:
        return False
    try:
        text = [line.decode('utf-8') for line in lines]
    except UnicodeDecodeError:
        return False
    if any('capacityOutput' in line or 'capacity result:' in line or
           re.match(r'^\s*(?:[\[{"\-0-9]|true\b|false\b|null\b)', line) for line in text):
        return False
    frames = [FRAME.fullmatch(text[i]) for i in (1, 3, 5)]
    if any(frame is None for frame in frames):
        return False
    path = frames[0].group(1)
    if any(frame.group(1) != path for frame in frames):
        return False
    return (text[1] == f'  File "{path}", line 409, in <module>' and
            text[2] == '    main()' and
            text[3] == f'  File "{path}", line 400, in main' and
            text[4] == "    run_probe(fixture, notify_fd, release_fd, observer, production_node, proof, gated_production and sys.argv[5] == 'capacity')" and
            text[5] == f'  File "{path}", line 351, in run_probe' and
            text[6] == "    raise RuntimeError('namespace capability unavailable' if unavailable else 'namespace probe failed')" and
            text[7] == 'RuntimeError: namespace probe failed')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def select(data):
    if len(data) > LIMIT or (data and not data.endswith(b'\n')):
        return 'invalid'
    lines = data.split(b'\n')[:-1] if data else []
    suffix = False
    records = []
    try:
        for index, line in enumerate(lines):
            if line == TRACEBACK:
                suffix = True
                if not terminal_traceback(lines[index:]):
                    return 'invalid'
                break
            row = json.loads(line, object_pairs_hook=unique_object)
            if not isinstance(row, dict):
                return 'invalid'
            if 'capacityOutput' in row:
                records.append(row)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return 'invalid'
    if not records:
        return 'invalid' if suffix else 'missing-capacity'
    if len(records) != 1:
        return 'invalid'
    record = records[0]
    output, status, idle = record.get('capacityOutput'), record.get('exit'), record.get('idleChildren')
    if not isinstance(output, str) or type(status) is not int or not 0 <= status <= 255 or type(idle) is not int or idle != 20:
        return 'invalid'
    count = output.count(MARKER)
    if count == 0:
        return 'invalid' if suffix else 'missing-result'
    if count != 1:
        return 'invalid'
    start = output.index(MARKER) + len(MARKER)
    try:
        result, end = json.JSONDecoder(object_pairs_hook=unique_object).raw_decode(output, start)
    except (ValueError, RecursionError):
        return 'invalid'
    if not isinstance(result, dict) or not SUFFIX.match(output, end):
        return 'invalid'
    state, remaining = result.get('state'), result.get('remaining')
    if state not in ('complete', 'incomplete') or not isinstance(remaining, list) or any(type(item) is not str or item not in RESOURCES for item in remaining) or len(set(remaining)) != len(remaining):
        return 'invalid'
    if state == 'complete':
        return 'complete' if not remaining else 'invalid'
    return 'eligible' if remaining and status > 0 else 'invalid'


def main(path):
    try:
        with Path(path).open('rb') as source:
            return select(source.read(LIMIT + 1))
    except OSError:
        return 'missing-log'


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(2)
    print(main(sys.argv[1]))
