"""Summarize preserved actual CI workflow runs, retaining failures and queue time."""
import datetime
import json
from pathlib import Path
import re
import statistics
import sys

VERIFY = 'Unit, build, E2E, and package'
ANSI = re.compile(r'(?:\x1b|\^\[)\[[0-9;]*m')


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def elapsed(start, end):
    return (timestamp(end) - timestamp(start)).total_seconds()


def summarize_run(run, log):
    if run['status'] != 'completed':
        return {'runId': run['databaseId'], 'status': run['status']}
    verify = [job for job in run['jobs'] if job['name'] == VERIFY]
    if len(verify) > 1:
        raise ValueError('Ambiguous verification aggregate')
    verification = verify[0] if verify and verify[0]['status'] == 'completed' else None
    jobs = [job for job in run['jobs'] if job['status'] == 'completed' and
            job['conclusion'] != 'skipped' and job.get('startedAt') and job.get('completedAt')]
    tests, files, failures = {}, {}, []
    for line in ANSI.sub('', log).splitlines():
        name = line.split('\t')[0]
        if not name.startswith('Vitest shard '):
            continue
        count = re.search(r'\bTests\s+.*\((\d+)\)', line)
        if count:
            tests[name] = int(count[1])
        count = re.search(r'\bTest Files\s+.*\((\d+)\)', line)
        if count:
            files[name] = int(count[1])
        if re.search(r'\bFAIL\s', line):
            failures.append(line.split('\t')[-1].strip())
    return {
        'runId': run['databaseId'], 'headSha': run['headSha'], 'url': run['url'],
        'status': run['status'], 'conclusion': run['conclusion'],
        'verificationConclusion': verification['conclusion'] if verification else None,
        'verificationWallSeconds': elapsed(run['createdAt'], verification['completedAt']) if verification else None,
        'workflowWallSeconds': elapsed(run['createdAt'], run['updatedAt']),
        'runnerSeconds': sum(elapsed(job['startedAt'], job['completedAt']) for job in jobs),
        'jobs': {job['name']: elapsed(job['startedAt'], job['completedAt']) for job in jobs},
        'testsByShard': tests, 'filesByShard': files, 'failures': failures,
    }


def summarize(root):
    rows = []
    for phase in ('current', 'candidate'):
        for path in sorted((root / phase).glob('*/run.json')):
            provider, repetition = path.parent.name.rsplit('-', 1)
            log = path.parent / 'workflow.log'
            row = summarize_run(json.loads(path.read_text()), log.read_text() if log.exists() else '')
            rows.append(dict(phase=phase, provider=provider, repetition=int(repetition), **row))
    groups = {}
    for phase in ('current', 'candidate'):
        for provider in ('github', 'blacksmith'):
            members = [r for r in rows if r['phase'] == phase and r['provider'] == provider]
            completed = [r for r in members if r['status'] == 'completed']
            passed = [r for r in completed if r['conclusion'] == 'success' and r['verificationConclusion'] == 'success']
            group = dict(successes=len(passed), failures=len(completed)-len(passed), pending=len(members)-len(completed))
            for metric in ('verificationWallSeconds', 'workflowWallSeconds', 'runnerSeconds'):
                values = [r[metric] for r in passed]
                group[metric] = dict(median=statistics.median(values), min=min(values), max=max(values)) if values else None
            groups[f'{phase}/{provider}'] = group
    return dict(rows=rows, groups=groups)


if __name__ == '__main__':
    print(json.dumps(summarize(Path(sys.argv[1])), indent=2))
