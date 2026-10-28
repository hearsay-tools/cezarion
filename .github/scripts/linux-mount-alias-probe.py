#!/usr/bin/env python3
"""Observe proc paths in a disposable Linux user and mount namespace."""
import json
import mmap
import os
import pathlib
import selectors
import subprocess
import sys
import tempfile

LIMIT = 4 * 1024 * 1024


def read_bounded(path, directory=None):
    try:
        with os.fdopen(os.open(path, os.O_RDONLY, dir_fd=directory), 'rb') as source:
            data = source.read(LIMIT + 1)
        if len(data) > LIMIT:
            return {'error': 'over byte limit'}
        return data.decode('utf-8', errors='replace')
    except OSError as error:
        return {'error': f'{error.__class__.__name__}: {error}'}


def snapshot(pid, fixture, directory=None):
    base = f'/proc/{pid}'
    def path(key): return key if directory is not None else f'{base}/{key}'
    result = {key: read_bounded(path(key), directory) for key in ('maps', 'mountinfo')}
    for key in ('cwd', 'root', 'ns/mnt'):
        try:
            result[key] = os.readlink(path(key), dir_fd=directory)
        except OSError as error:
            result[key] = {'error': f'{error.__class__.__name__}: {error}'}
    try:
        result['fd'] = {}
        fd_dir = os.open(path('fd'), os.O_RDONLY | os.O_DIRECTORY, dir_fd=directory)
        for entry in os.listdir(fd_dir):
            try:
                result['fd'][entry] = os.readlink(entry, dir_fd=fd_dir)
            except OSError:
                continue
        os.close(fd_dir)
    except OSError as error:
        result['fd'] = {'error': str(error)}
    if isinstance(result['maps'], str):
        result['maps'] = [line for line in result['maps'].splitlines() if fixture in line or '/mapped' in line]
    return result


def mount(*args):
    subprocess.run(['mount', *args], check=True, timeout=10, stdout=subprocess.DEVNULL)


def child(fixture):
    root = pathlib.Path(fixture)
    owned, alias, other = (root / name for name in ('owned', 'alias', 'other'))
    for path in (owned, alias, other, owned / 'nested', other / 'nested'):
        path.mkdir(exist_ok=True)
    file = owned / 'mapped'; file.write_bytes(b'x' * 4096)
    (other / 'nested' / 'other').write_bytes(b'y' * 4096)
    mount('--make-rprivate', '/')
    mount('--bind', str(owned), str(alias))
    with open(alias / 'mapped', 'rb') as descriptor:
        mapped = mmap.mmap(descriptor.fileno(), 4096, access=mmap.ACCESS_READ)
    os.chdir('/')

    def event(case, proc_dir=None):
        print(json.dumps({'case': case, 'pid': os.getpid(), 'inside': snapshot('self', fixture, proc_dir)}), flush=True)
        if sys.stdin.readline().strip() != 'continue':
            raise RuntimeError('reader did not acknowledge snapshot')

    event('private-bind-closed-fd')
    os.chdir(alias)
    event('same-namespace-cwd')
    os.chdir('/')
    with open(alias / 'mapped', 'rb'):
        event('same-namespace-open-fd')
    (owned / 'nested' / 'mapped-nested').write_bytes(b'z' * 4096)
    with open(alias / 'nested' / 'mapped-nested', 'rb') as nested_fd:
        nested = mmap.mmap(nested_fd.fileno(), 4096, access=mmap.ACCESS_READ)
    mount('--bind', str(other / 'nested'), str(alias / 'nested'))
    event('nested-overmount')
    pid = os.fork()
    if pid == 0:
        try:
            proc_dir = os.open('/proc/self', os.O_RDONLY | os.O_DIRECTORY)
            os.chroot(fixture); os.chdir('/')
            event('changed-root', proc_dir)
            os.close(proc_dir)
            os._exit(0)
        except OSError as error:
            print(json.dumps({'case': 'changed-root', 'capability': 'unavailable', 'error': str(error)}), flush=True)
            os._exit(0)
    _, status = os.waitpid(pid, 0)
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError('changed-root child failed')
    nested.close(); mapped.close()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--child':
        child(sys.argv[2]); return
    with tempfile.TemporaryDirectory(prefix='cez-mount-probe-') as fixture:
        command = ['unshare', '--user', '--map-root-user', '--mount', '--fork', '--kill-child',
                   sys.executable, __file__, '--child', fixture]
        print(json.dumps({'command': command, 'scope': 'disposable user and mount namespaces'}), flush=True)
        try:
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1)
        except OSError as error:
            print(json.dumps({'capability': 'unavailable', 'error': str(error)})); return
        selector = selectors.DefaultSelector(); selector.register(proc.stdout, selectors.EVENT_READ)
        cases = []
        try:
            while True:
                if not selector.select(timeout=20):
                    raise TimeoutError('namespace probe timed out')
                line = proc.stdout.readline()
                if not line:
                    break
                record = json.loads(line)
                if 'pid' in record:
                    record['outside'] = snapshot(record['pid'], fixture)
                    cases.append(record['case'])
                    proc.stdin.write('continue\n'); proc.stdin.flush()
                print(json.dumps(record), flush=True)
            stderr = proc.stderr.read(LIMIT)
            status = proc.wait(timeout=10)
            if status:
                unavailable = not cases and ('Operation not permitted' in stderr or 'Permission denied' in stderr)
                print(json.dumps({'capability': 'unavailable' if unavailable else 'failed', 'status': status, 'stderr': stderr}), flush=True)
                if not unavailable: raise RuntimeError('namespace probe failed')
            else:
                print(json.dumps({'capability': 'available', 'observed_cases': cases, 'stderr': stderr}), flush=True)
        finally:
            selector.close()
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait(timeout=5)


if __name__ == '__main__':
    main()
