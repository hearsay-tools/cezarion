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
    (out / f'{name}.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    return result


def capture(command, root):
    return subprocess.check_output(command, cwd=root, text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--variant', required=True)
    parser.add_argument('--phase', choices=['verify', 'snapshot'], default='verify')
    args = parser.parse_args()
    root, out = args.root.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    metadata = dict(variant=args.variant, phase=args.phase, baseline=capture(['git', 'rev-parse', 'HEAD'], root),
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
    patch_file = Path(__file__).with_name(args.variant + '.patch')
    if patch_file.is_file():
        metadata['experimentPatchSha256'] = hashlib.sha256(patch_file.read_bytes()).hexdigest()
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    steps = [('install', ['npm', 'ci', '--cache', str(out / 'npm-cache')]),
             ('typecheck', ['npm', 'run', 'typecheck']),
             ('unit', ['npm', 'run', 'test:unit'])]
    vitest = ['npm', 'test', '--', '--reporter=default', '--reporter=json', f'--outputFile={out / "vitest.json"}']
    if args.variant.startswith('workers-'):
        vitest.append('--maxWorkers=' + str(int(args.variant.split('-')[1])))
    if args.variant in ('shards-1', 'shards-2'):
        manifest = json.loads(Path(__file__).with_name('shards.json').read_text())
        expected = []
        for package in ('cezar', 'api-client', 'web'):
            for path in (root / f'packages/{package}/src').rglob('*'):
                if path.name.endswith('.test.ts') or (package == 'web' and path.name.endswith('.test.tsx')):
                    expected.append(path.relative_to(root).as_posix())
        validate_inventory(manifest['shards'], expected)
        vitest += manifest['shards'][int(args.variant[-1]) - 1]
        metadata['shardManifest'] = manifest
        (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    steps.append(('vitest', vitest))
    if args.variant == 'build-reuse':
        steps += [('build-web', ['npm', 'run', 'build:web']), ('check-pack', ['npm', 'run', 'check:pack'])]
    else:
        steps += [('build', ['npm', 'run', 'build'])]
    steps += [('package', ['npm', 'run', 'test:package'])]
    if args.variant in ('shards-1', 'shards-2'):
        steps = [steps[0], ('build-server', ['npm', 'run', 'build:server']), ('vitest', vitest)]
    elif args.variant == 'shards-gate':
        steps = [step for step in steps if step[0] != 'vitest']
    if args.phase == 'snapshot':
        steps = [] if args.variant == 'snapshot-reuse' else [
            ('install', ['npm', 'ci', '--cache', str(out / 'npm-cache')]),
            ('build', ['npm', 'run', 'build']),
        ]
        if args.variant == 'snapshot-reuse':
            metadata['cache'] = 'verified node_modules and build artifacts transferred from baseline job'
        steps += [('snapshot', ['node', 'scripts/release-snapshot.mjs', '--dry-run'])]
        (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    results = []
    for name, command in steps:
        result = run_step(name, command, root, out)
        results.append(result)
        if name == 'install' and result['exitCode'] == 0:
            metadata['vitestVersion'] = json.loads((root / 'node_modules/vitest/package.json').read_text())['version']
            for chunk in (root / 'node_modules/vitest/dist/chunks').glob('*.js'):
                source = chunk.read_text()
                start = source.find('function resolveMaxWorkers(')
                if start >= 0:
                    metadata['poolSource'] = source[start:source.index('\n}', start) + 2]
                    break
            (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
        if result['exitCode']:
            break
    (out / 'summary.json').write_text(json.dumps(dict(steps=results, completedAt=time.time()), indent=2) + '\n')
    return next((result['exitCode'] for result in results if result['exitCode']), 0)


if __name__ == '__main__':
    raise SystemExit(main())
