"""Aggregate issue #156 benchmark artifacts and GitHub job timings."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
from statistics import median


JOB_NAME = re.compile(r'^(measure|snapshot) \((.+), (\d+)\)$')


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def elapsed_seconds(job):
    try:
        start = datetime.fromisoformat(job['started_at'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(job['completed_at'].replace('Z', '+00:00'))
        return (end - start).total_seconds()
    except (KeyError, TypeError, ValueError):
        return None


def stats(values):
    if not values:
        return None
    return {'median': median(values), 'min': min(values), 'max': max(values)}


def job_rows(root):
    document = read_json(root / 'jobs.json') or {}
    rows = []
    for raw in document.get('jobs', []):
        match = JOB_NAME.match(raw.get('name', ''))
        if not match:
            continue
        kind, variant, repetition = match.groups()
        rows.append({
            'variant': variant,
            'repetition': int(repetition),
            'phase': 'snapshot' if kind == 'snapshot' else 'verify',
            'conclusion': raw.get('conclusion'),
            'jobRunnerSeconds': elapsed_seconds(raw),
            'raw': raw,
        })
    return rows


def artifact_rows(root):
    rows = {}
    for path in sorted(root.glob('benchmark-*/metadata.json')):
        metadata = read_json(path)
        if not isinstance(metadata, dict):
            continue
        try:
            key = (str(metadata['variant']), int(metadata['repetition']),
                   str(metadata.get('phase', 'verify')))
        except (KeyError, TypeError, ValueError):
            continue
        rows[key] = {'path': path.parent, 'metadata': metadata}
    return rows


def sample_metrics(steps):
    verification = [step for step in steps if step.get('name') != 'install']
    install = next((step for step in steps if step.get('name') == 'install'), None)
    vitest = next((step for step in steps if step.get('name') == 'vitest'), None)
    return {
        'verificationSeconds': sum(step.get('wallSeconds', 0) for step in verification),
        'installSeconds': install.get('wallSeconds') if install else None,
        'vitestSeconds': vitest.get('wallSeconds') if vitest else None,
        'cpuSeconds': sum(step.get('userSeconds', 0) + step.get('systemSeconds', 0) for step in steps),
        'peakMaxChildRssKiB': max((step.get('maxChildRssKiB', 0) for step in steps), default=0),
    }


def valid_steps(steps):
    required = {'name', 'wallSeconds', 'userSeconds', 'systemSeconds',
                'maxChildRssKiB', 'exitCode'}
    return bool(steps) and all(isinstance(step, dict) and required <= step.keys() for step in steps)


def summarize(root):
    root = Path(root)
    jobs = job_rows(root)
    artifacts = artifact_rows(root)
    indexed_jobs = {(row['variant'], row['repetition'], row['phase']): row for row in jobs}
    keys = sorted(set(artifacts) | set(indexed_jobs))
    variants = {}
    for variant, repetition, phase in keys:
        artifact = artifacts.get((variant, repetition, phase))
        job = indexed_jobs.get((variant, repetition, phase))
        sample = {
            'variant': variant, 'repetition': repetition, 'phase': phase,
            'artifact': str(artifact['path']) if artifact else None,
            'jobRunnerSeconds': job.get('jobRunnerSeconds') if job else None,
            'jobConclusion': job.get('conclusion') if job else None,
        }
        summary = read_json(artifact['path'] / 'summary.json') if artifact else None
        if (not isinstance(summary, dict) or not isinstance(summary.get('steps'), list)
                or not valid_steps(summary['steps'])):
            sample.update(status='missing', reason='missing or invalid summary.json')
        else:
            steps = summary['steps']
            sample['steps'] = steps
            sample['metrics'] = sample_metrics(steps)
            failed_steps = [step for step in steps if step.get('exitCode') != 0]
            job_failed = job is not None and job.get('conclusion') != 'success'
            if failed_steps or job_failed:
                sample.update(status='failure', failedSteps=[step.get('name') for step in failed_steps])
            elif job is None:
                sample.update(status='missing', reason='missing GitHub job')
            else:
                sample['status'] = 'success'
        variants.setdefault(variant, []).append(sample)

    aggregates = {}
    metric_names = ('verificationSeconds', 'installSeconds', 'vitestSeconds',
                    'cpuSeconds', 'peakMaxChildRssKiB', 'jobRunnerSeconds')
    for variant, samples in variants.items():
        successful = [sample for sample in samples if sample['status'] == 'success']
        failures = [sample for sample in samples if sample['status'] == 'failure']
        metrics = {}
        for name in metric_names:
            values = []
            for sample in successful:
                value = sample.get('jobRunnerSeconds') if name == 'jobRunnerSeconds' else sample['metrics'].get(name)
                if value is not None:
                    values.append(value)
            metrics[name] = stats(values)
        aggregates[variant] = {
            'successes': len(successful),
            'failures': len(failures),
            'missing': sum(sample['status'] == 'missing' for sample in samples),
            'metrics': metrics,
            'allMeasuredVitestSeconds': stats([
                sample['metrics']['vitestSeconds'] for sample in samples
                if sample.get('metrics', {}).get('vitestSeconds') is not None
            ]),
            'failureSamples': failures,
            'samples': samples,
        }
    return {'variants': aggregates, 'jobs': jobs}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('run_directory', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    output = json.dumps(summarize(args.run_directory), indent=2) + '\n'
    if args.out:
        args.out.write_text(output)
    else:
        print(output, end='')


if __name__ == '__main__':
    main()
