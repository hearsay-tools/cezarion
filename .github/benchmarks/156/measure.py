"""Issue 156: Linux/GNU-time collector. Run only on GitHub for benchmark results."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time

from balance import validate_inventory


def release_verification_steps():
    return [('install', ['npm', 'ci']),
            ('typecheck', ['npm', 'run', 'typecheck']),
            ('unit', ['npm', 'run', 'test:unit']),
            ('vitest', ['npm', 'test']),
            ('build', ['npm', 'run', 'build'])]


def run_step(name, command, root, out):
    started = time.time()
    resource_file = out / f'{name}.time'
    with (out / f'{name}.log').open('w') as log:
        completed = subprocess.run(
            ['/usr/bin/time', '-f', '%e\t%U\t%S\t%M', '-o', str(resource_file), '--', *command],
            cwd=root, stdout=log, stderr=subprocess.STDOUT, check=False,
        )
    # GNU time prefixes an unsuccessful command with its exit/signal diagnostic.
    elapsed, user, system, rss = resource_file.read_text().strip().splitlines()[-1].split('\t')
    result = dict(name=name, command=command, startedAt=started, completedAt=time.time(),
                  wallSeconds=float(elapsed), userSeconds=float(user), systemSeconds=float(system),
                  maxChildRssKiB=int(rss), exitCode=completed.returncode)
    (out / f'step-{name}.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    return result


def capture(command, root):
    return subprocess.check_output(command, cwd=root, text=True).strip()


def write_metadata(out, metadata):
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')


def build_metadata(args, root):
    return dict(variant=args.variant, phase=args.phase, baseline=capture(['git', 'rev-parse', 'HEAD'], root),
                originalEvent=os.environ.get('GITHUB_EVENT_NAME'), originalRef=os.environ.get('GITHUB_REF_NAME'),
                harnessSha=os.environ.get('GITHUB_SHA'), runId=os.environ.get('GITHUB_RUN_ID'),
                attempt=os.environ.get('GITHUB_RUN_ATTEMPT'), repetition=os.environ.get('REPETITION'),
                imageOS=os.environ.get('ImageOS'), imageVersion=os.environ.get('ImageVersion'),
                runner=os.environ.get('RUNNER_NAME'), platform=platform.platform(),
                node=capture(['node', '--version'], root), npm=capture(['npm', '--version'], root),
                cpu=capture(['node', '-e', 'console.log(JSON.stringify({available:require("os").availableParallelism(),cpus:require("os").cpus()}))'], root),
                memory=Path('/proc/meminfo').read_text(),
                lockSha256=hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest(),
                patch=capture(['git', 'diff', '--binary', 'HEAD'], root),
                startedAt=time.time(), cache='cold private npm cache; no node_modules reuse')


def add_patch_hashes(args, root, metadata):
    patch_name = 'combined' if args.variant.startswith('combined-shards-') else args.variant
    patch_file = Path(__file__).with_name(patch_name + '.patch')
    if args.variant.startswith('split-shards-'):
        patch_file = Path(__file__).parent.parent / 'shard-balance' / 'worker-wait-split.patch'
    duration_file = root / '.github/test-durations.json'
    if duration_file.is_file():
        metadata['durationManifestSha256'] = hashlib.sha256(duration_file.read_bytes()).hexdigest()
    if patch_file.is_file():
        metadata['experimentPatchSha256'] = hashlib.sha256(patch_file.read_bytes()).hexdigest()


def package_test_files(root, package):
    return [path.relative_to(root).as_posix()
            for path in (root / f'packages/{package}/src').rglob('*')
            if path.name.endswith('.test.ts') or (package == 'web' and path.name.endswith('.test.tsx'))]


def shard_inventory(root):
    expected = []
    for package in ('cezar', 'api-client', 'web'):
        expected += package_test_files(root, package)
    return expected


def vitest_command(args, root, out, metadata):
    vitest = ['npm', 'test', '--', '--reporter=default', '--reporter=json', f'--outputFile={out / "vitest.json"}']
    if args.max_workers is not None:
        vitest.append(f'--maxWorkers={args.max_workers}')
    elif args.variant.startswith('workers-'):
        vitest.append('--maxWorkers=' + str(int(args.variant.split('-')[1])))
    if args.shard is not None:
        vitest.append(f'--shard={args.shard}/2')
    elif args.variant in ('combined-shards-1', 'combined-shards-2'):
        vitest.append(f'--shard={args.variant[-1]}/2')
    elif args.variant in ('shards-1', 'shards-2'):
        manifest = json.loads(Path(__file__).with_name('shards.json').read_text())
        validate_inventory(manifest['shards'], shard_inventory(root))
        vitest += manifest['shards'][int(args.variant[-1]) - 1]
        metadata['shardManifest'] = manifest
        write_metadata(out, metadata)
    return vitest


def plan_steps(args, out, metadata, vitest):
    steps = [('install', ['npm', 'ci', '--cache', str(out / 'npm-cache')]),
             ('typecheck', ['npm', 'run', 'typecheck']),
             ('unit', ['npm', 'run', 'test:unit'])]
    steps.append(('vitest', vitest))
    if args.variant == 'build-reuse':
        steps += [('build-web', ['npm', 'run', 'build:web']), ('check-pack', ['npm', 'run', 'check:pack'])]
    else:
        steps += [('build', ['npm', 'run', 'build'])]
    steps += [('package', ['npm', 'run', 'test:package'])]
    if args.phase == 'release-verify':
        steps = release_verification_steps()
        metadata['cache'] = 'setup-node npm cache; npm ci uses the default npm cache path'
        write_metadata(out, metadata)
    if args.shard is not None or args.variant in ('shards-1', 'shards-2', 'combined-shards-1', 'combined-shards-2'):
        steps = [steps[0], ('build-server', ['npm', 'run', 'build:server']), ('vitest', vitest)]
    elif args.variant in ('shards-gate', 'combined-shards-gate'):
        steps = [step for step in steps if step[0] != 'vitest']
    return steps


def apply_snapshot_phase(args, out, metadata, steps):
    if args.phase != 'snapshot':
        return steps
    # Simulate the eligible nightly event only inside this dry-run subprocess environment.
    os.environ.update(GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF_NAME='main', CEZ_RELEASE_CHANNEL='nightly')
    os.environ.setdefault('NIGHTLY_DATE', '20260908')
    metadata['simulatedSnapshotContext'] = {'event': 'workflow_dispatch', 'ref': 'main', 'channel': 'nightly', 'dryRun': True}
    planned = [] if args.variant == 'snapshot-reuse' else [
        ('install', ['npm', 'ci', '--cache', str(out / 'npm-cache')]),
        ('build', ['npm', 'run', 'build']),
    ]
    if args.variant == 'snapshot-reuse':
        metadata['cache'] = 'verified node_modules and build artifacts transferred from baseline job'
    planned += [('snapshot', ['node', 'scripts/release-snapshot.mjs', '--dry-run'])]
    write_metadata(out, metadata)
    return planned


def validate_snapshot_publication(out, result):
    lines = (out / 'snapshot.log').read_text().splitlines()
    payloads = [line.removeprefix('release-snapshot result: ') for line in lines if line.startswith('release-snapshot result: ')]
    payload = json.loads(payloads[-1]) if payloads else {}
    if payload.get('attempted') is not True or payload.get('dryRun') is not True:
        result.update(commandExitCode=0, exitCode=1, validationError='snapshot did not attempt dry-run publication')
        (out / 'step-snapshot.json').write_text(json.dumps(result, indent=2) + '\n')


def record_vitest_pool(root, out, metadata):
    metadata['vitestVersion'] = json.loads((root / 'node_modules/vitest/package.json').read_text())['version']
    for chunk in (root / 'node_modules/vitest/dist/chunks').glob('*.js'):
        source = chunk.read_text()
        start = source.find('function resolveMaxWorkers(')
        if start >= 0:
            metadata['poolSource'] = source[start:source.index('\n}', start) + 2]
            break
    write_metadata(out, metadata)


def run_steps(steps, root, out, metadata):
    results = []
    for name, command in steps:
        result = run_step(name, command, root, out)
        if name == 'snapshot' and result['exitCode'] == 0:
            validate_snapshot_publication(out, result)
        results.append(result)
        if name == 'install' and result['exitCode'] == 0:
            record_vitest_pool(root, out, metadata)
        if result['exitCode']:
            break
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--variant', required=True)
    parser.add_argument('--phase', choices=['verify', 'snapshot', 'release-verify'], default='verify')
    parser.add_argument('--max-workers', type=int, choices=[4, 6, 8])
    parser.add_argument('--shard', type=int, choices=[1, 2])
    args = parser.parse_args()
    root, out = args.root.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    metadata = build_metadata(args, root)
    add_patch_hashes(args, root, metadata)
    write_metadata(out, metadata)
    vitest = vitest_command(args, root, out, metadata)
    steps = plan_steps(args, out, metadata, vitest)
    steps = apply_snapshot_phase(args, out, metadata, steps)
    results = run_steps(steps, root, out, metadata)
    (out / 'summary.json').write_text(json.dumps(dict(steps=results, completedAt=time.time()), indent=2) + '\n')
    return next((result['exitCode'] for result in results if result['exitCode']), 0)


if __name__ == '__main__':
    raise SystemExit(main())
