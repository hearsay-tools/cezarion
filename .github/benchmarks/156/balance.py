"""Build a complete, duration-balanced two-shard manifest from Vitest JSON."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import re


def assign(durations, count):
    if count < 1 or not durations:
        raise ValueError('positive shard count and nonempty durations required')
    bins = [[] for _ in range(count)]
    totals = [0] * count
    for name, duration in sorted(durations.items(), key=lambda pair: (-pair[1], pair[0])):
        target = min(range(count), key=lambda index: (totals[index], index))
        bins[target].append(name)
        totals[target] += duration
    return bins


def validate_inventory(bins, expected):
    actual = Counter(name for group in bins for name in group)
    if any(count != 1 for count in actual.values()):
        raise ValueError('duplicate file in shards')
    if set(actual) != set(expected):
        raise ValueError('shard inventory differs from complete test inventory')


def console_durations(text):
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    packages = {'server': 'cezar', 'web': 'web', 'api-client': 'api-client'}
    pattern = r'^\s*[✓❯×]\s+\|?(server|web|api-client)\|?\s+(src/\S+\.test\.(?:ts|tsx))\s+\([^\n]*\)\s+(\d+(?:\.\d+)?)(ms|s)'
    results = {}
    for project, path, duration, unit in re.findall(pattern, text, re.MULTILINE):
        name = f'packages/{packages[project]}/{path}'
        if name in results:
            raise ValueError(f'duplicate suite duration: {name}')
        results[name] = float(duration) * (1000 if unit == 's' else 1)
    if not results:
        raise ValueError('no suite durations found in console log')
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    samples = {}
    expected = None
    for report in args.reports:
        if report.suffix == '.log':
            durations = console_durations(report.read_text())
        else:
            data = json.loads(report.read_text())
            durations = {}
            for suite in data['testResults']:
                name = 'packages/' + suite['name'].split('/packages/', 1)[1]
                if name in durations:
                    raise ValueError(f'duplicate result: {name}')
                durations[name] = suite['endTime'] - suite['startTime']
        names = set(durations)
        for name, duration in durations.items():
            samples.setdefault(name, []).append(duration)
        if expected is not None and names != expected:
            raise ValueError('report inventories disagree')
        expected = names
    durations = {name: statistics.median(values) for name, values in samples.items()}
    bins = assign(durations, 2)
    validate_inventory(bins, expected)
    args.out.write_text(json.dumps(dict(shards=bins, durationsMs=durations,
                                       sourceReports=[str(path) for path in args.reports]), indent=2) + '\n')


if __name__ == '__main__':
    main()
