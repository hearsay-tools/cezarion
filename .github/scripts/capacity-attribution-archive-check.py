"""Check relative setup imports in the actual tracked diagnostic archive, without importing them."""
import io
import re
import shlex
import subprocess
import sys
import tarfile
from pathlib import PurePosixPath

revision = sys.argv[1] if len(sys.argv) > 1 else 'HEAD'
workflow = subprocess.check_output(['git', 'show', f'{revision}:.github/workflows/worker-destroy-linux-namespace.yml'], text=True)
lines = [line.strip() for line in workflow.splitlines() if line.strip().startswith('git archive HEAD -- ')]
if len(lines) != 1:
    raise SystemExit('expected one diagnostic archive command')
arguments = shlex.split(lines[0].split(' | ', 1)[0])[4:]
archive = subprocess.check_output(['git', 'archive', revision, '--', *arguments])
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    members = {member.name: member for member in tar if member.isfile()}
    names = set(members)
    if 'packages/cezar/src/delegation/capacity-reaper-observation.testkit.ts' not in names:
        raise SystemExit('missing archived capacity reaper observation helper')
    files = {name: tar.extractfile(member).read().decode('utf-8')
             for name, member in members.items() if name.endswith(('.ts', '.js', '.mjs', '.cjs'))}

project_block = re.search(r'projects:\s*\[([^\]]+)\]', files['vitest.config.ts'])
if not project_block:
    raise SystemExit('missing root Vitest project list')
projects = re.findall(r"['\"](\./[^'\"]+/vitest\.config\.ts)['\"]", project_block.group(1))
if len(projects) != 5 or len(re.findall(r"['\"][^'\"]+['\"]", project_block.group(1))) != len(projects):
    raise SystemExit('unexpected Vitest project list')
roots = ['vitest.config.ts', *[project[2:] for project in projects],
         'packages/cezar/vitest.setup.ts', 'scripts/test-sandbox.mjs']
pending = list(roots)
seen = set()
pattern = re.compile(r"(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['\"](\.[^'\"]+)['\"]")
read_url = re.compile(r"readFileSync\s*\(\s*new URL\s*\(\s*['\"](\.[^'\"]+)['\"]\s*,\s*import\.meta\.url\s*\)")
data_files = set()

def resolve_relative(name, specifier):
    path = PurePosixPath(name).parent.joinpath(specifier)
    parts = []
    for part in path.parts:
        if part == '..':
            if not parts:
                raise SystemExit(f'import outside archive: {name}: {specifier}')
            parts.pop()
        elif part != '.':
            parts.append(part)
    return '/'.join(parts)

while pending:
    name = pending.pop()
    if name in seen:
        continue
    if name not in files:
        raise SystemExit(f'missing archived dependency: {name}')
    seen.add(name)
    if name.endswith(('vitest.config.ts', 'vite.config.ts', '-test-sequencer.mjs')):
        reads = read_url.findall(files[name])
        if len(re.findall(r'\breadFileSync\s*\(', files[name])) != len(reads):
            raise SystemExit(f'unsupported data read in {name}')
        for specifier in reads:
            target = resolve_relative(name, specifier)
            if target not in names:
                raise SystemExit(f'missing archived data: {name}: {target}')
            data_files.add(target)
    for specifier in pattern.findall(files[name]):
        target = resolve_relative(name, specifier)
        candidates = [target]
        if target.endswith('.js'):
            candidates.append(target[:-3] + '.ts')
        candidates += [target + suffix for suffix in ('.ts', '.js', '.mjs', '/index.ts')]
        found = next((candidate for candidate in candidates if candidate in files), None)
        if found is None:
            raise SystemExit(f'missing archived dependency: {name}: {specifier}')
        pending.append(found)
print(f'checked {len(seen)} archived setup/config modules and {len(data_files)} data files')
