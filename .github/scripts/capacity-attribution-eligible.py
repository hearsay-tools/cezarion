"""Select a failed capacity result without exposing runtime evidence."""
import json
from pathlib import Path
import re
import sys

LIMIT = 8 * 1024 * 1024
MARKER = 'capacity result: '
RESOURCES = {'process', 'worktree', 'branch'}
SUFFIX = re.compile(r', [0-9]+ reaper calls, [0-9]+ ms(?:\r?\n|$)')


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
    records = []
    try:
        for line in data.splitlines():
            row = json.loads(line, object_pairs_hook=unique_object)
            if not isinstance(row, dict):
                return 'invalid'
            if 'capacityOutput' in row:
                records.append(row)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return 'invalid'
    if not records:
        return 'missing-capacity'
    if len(records) != 1:
        return 'invalid'
    record = records[0]
    output, status, idle = record.get('capacityOutput'), record.get('exit'), record.get('idleChildren')
    if not isinstance(output, str) or type(status) is not int or not 0 <= status <= 255 or type(idle) is not int or idle != 20:
        return 'invalid'
    count = output.count(MARKER)
    if count == 0:
        return 'missing-result'
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
