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
    files = {member.name: tar.extractfile(member).read().decode('utf-8')
             for member in tar if member.isfile() and member.name.endswith(('.ts', '.js', '.mjs', '.cjs'))}

roots = ['vitest.config.ts', 'packages/cezar/vitest.config.ts',
         'packages/cezar/vitest.setup.ts', 'scripts/test-sandbox.mjs']
pending = list(roots)
seen = set()
pattern = re.compile(r"(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['\"](\.[^'\"]+)['\"]")
while pending:
    name = pending.pop()
    if name in seen:
        continue
    if name not in files:
        raise SystemExit(f'missing archived dependency: {name}')
    seen.add(name)
    for specifier in pattern.findall(files[name]):
        path = PurePosixPath(name).parent.joinpath(specifier)
        # Resolve dot segments without accessing the filesystem.
        parts = []
        for part in path.parts:
            if part == '..':
                if not parts:
                    raise SystemExit(f'import outside archive: {name}: {specifier}')
                parts.pop()
            elif part != '.':
                parts.append(part)
        target = '/'.join(parts)
        candidates = [target]
        if target.endswith('.js'):
            candidates.append(target[:-3] + '.ts')
        if not PurePosixPath(target).suffix:
            candidates += [target + suffix for suffix in ('.ts', '.js', '.mjs', '/index.ts')]
        found = next((candidate for candidate in candidates if candidate in files), None)
        if found is None:
            raise SystemExit(f'missing archived dependency: {name}: {specifier}')
        pending.append(found)
print(f'checked {len(seen)} archived setup/config modules')
