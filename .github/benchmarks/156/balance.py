"""Build a complete, duration-balanced two-shard manifest from Vitest JSON."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    samples = {}
    expected = None
    for report in args.reports:
        data = json.loads(report.read_text())
        names = set()
        for suite in data['testResults']:
            name = 'packages/' + suite['name'].split('/packages/', 1)[1]
            if name in names:
                raise ValueError(f'duplicate result: {name}')
            names.add(name)
            samples.setdefault(name, []).append(suite['endTime'] - suite['startTime'])
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
