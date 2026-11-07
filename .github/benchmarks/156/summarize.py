"""Aggregate issue #156 benchmark artifacts and GitHub job timings."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
from statistics import median


JOB_NAME = re.compile(r'^(measure|snapshot) \((.+), (\d+)\)$')
PAIRED_JOB_NAME = re.compile(r'^paired \((\d+)\)$')


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def elapsed_seconds(job):
    try:
        started_at = job['started_at']
        completed_at = job['completed_at']
        if not isinstance(started_at, str) or not isinstance(completed_at, str):
            return None
        start = datetime.fromisoformat(started_at.replace('Z', '+00:00'))
        end = datetime.fromisoformat(completed_at.replace('Z', '+00:00'))
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
        paired = PAIRED_JOB_NAME.match(raw.get('name', ''))
        if not match and not paired:
            continue
        if paired:
            kind, variant, repetition = 'paired', 'paired', paired.group(1)
        else:
            kind, variant, repetition = match.groups()
        phase = ('snapshot' if kind == 'snapshot' else
                 'release-verify' if variant.startswith('release-') else 'verify')
        rows.append({
            'variant': variant,
            'repetition': int(repetition),
            'phase': phase,
            'paired': kind == 'paired',
            'status': raw.get('status'),
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


METRIC_NAMES = ('verificationSeconds', 'installSeconds', 'vitestSeconds',
                'cpuSeconds', 'peakMaxChildRssKiB', 'jobRunnerSeconds')


def job_index(jobs):
    indexed = {
        (row['variant'], row['repetition'], row['phase']): row
        for row in jobs if not row['paired']
    }
    for row in jobs:
        if row['paired']:
            for variant in ('baseline', 'combined'):
                indexed[(variant, row['repetition'], row['phase'])] = row
    return indexed


def sample_header(variant, repetition, phase, artifact, job):
    return {
        'variant': variant, 'repetition': repetition, 'phase': phase,
        'artifact': str(artifact['path']) if artifact else None,
        # A paired job runs both collectors sequentially. Keep its elapsed
        # time as shared evidence rather than charging it to both samples.
        'jobRunnerSeconds': (
            job.get('jobRunnerSeconds') if job and not job['paired'] else None
        ),
        'sharedJobRunnerSeconds': (
            job.get('jobRunnerSeconds') if job and job['paired'] else None
        ),
        'jobStatus': job.get('status') if job else None,
        'jobConclusion': job.get('conclusion') if job else None,
    }


def classify_sample(sample, artifact, job):
    summary = read_json(artifact['path'] / 'summary.json') if artifact else None
    if (not isinstance(summary, dict) or not isinstance(summary.get('steps'), list)
            or not valid_steps(summary['steps'])):
        sample.update(status='missing', reason='missing or invalid summary.json')
        return
    steps = summary['steps']
    sample['steps'] = steps
    sample['metrics'] = sample_metrics(steps)
    failed_steps = [step for step in steps if step.get('exitCode') != 0]
    if job is None:
        sample.update(status='missing', reason='missing GitHub job')
    elif job.get('status') != 'completed' or job.get('conclusion') is None:
        sample.update(status='missing', reason='GitHub job is not complete')
    elif failed_steps or (not job['paired'] and job.get('conclusion') != 'success'):
        sample.update(status='failure', failedSteps=[step.get('name') for step in failed_steps])
    else:
        sample['status'] = 'success'


def metric_value(sample, name):
    return sample.get('jobRunnerSeconds') if name == 'jobRunnerSeconds' else sample['metrics'].get(name)


def variant_aggregate(samples):
    successful = [sample for sample in samples if sample['status'] == 'success']
    failures = [sample for sample in samples if sample['status'] == 'failure']
    metrics = {}
    for name in METRIC_NAMES:
        values = []
        for sample in successful:
            value = metric_value(sample, name)
            if value is not None:
                values.append(value)
        metrics[name] = stats(values)
    return {
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


def summarize(root):
    root = Path(root)
    jobs = job_rows(root)
    artifacts = artifact_rows(root)
    indexed = job_index(jobs)
    variants = {}
    for variant, repetition, phase in sorted(set(artifacts) | set(indexed)):
        artifact = artifacts.get((variant, repetition, phase))
        job = indexed.get((variant, repetition, phase))
        sample = sample_header(variant, repetition, phase, artifact, job)
        classify_sample(sample, artifact, job)
        variants.setdefault(variant, []).append(sample)
    aggregates = {}
    for variant, samples in variants.items():
        aggregates[variant] = variant_aggregate(samples)
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
