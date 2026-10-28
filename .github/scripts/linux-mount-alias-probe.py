#!/usr/bin/env python3
"""Observe proc paths in a disposable Linux user and mount namespace."""
import json
import ctypes
import os
import pathlib
import selectors
import subprocess
import sys
import tempfile
import shutil
import signal
import threading
import time

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


def map_file(path):
    # libc mmap does not duplicate the descriptor (unlike Python mmap).
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long)
    libc.munmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t)
    fd = os.open(path, os.O_RDONLY)
    try:
        identity = os.fstat(fd)
        address = libc.mmap(None, 4096, 1, 2, fd, 0)  # PROT_READ, MAP_PRIVATE
        if address == ctypes.c_void_p(-1).value:
            raise OSError(ctypes.get_errno(), 'mmap failed')
    finally:
        os.close(fd)
    return libc, address, (identity.st_dev, identity.st_ino)


def assert_fd_free(identity, directory=None):
    fd_dir = os.open('fd' if directory is not None else '/proc/self/fd',
                     os.O_RDONLY | os.O_DIRECTORY, dir_fd=directory)
    try:
        for name in os.listdir(fd_dir):
            try:
                info = os.stat(name, dir_fd=fd_dir)
            except FileNotFoundError:
                continue
            if (info.st_dev, info.st_ino) == identity:
                raise RuntimeError('mapped fixture descriptor remains open')
    finally:
        os.close(fd_dir)


def child(fixture, lifeline):
    def watch_parent():
        try:
            while os.read(lifeline, 1):
                pass
        finally:
            os._exit(125)  # PID namespace init exit tears down every descendant.
    threading.Thread(target=watch_parent, daemon=True).start()

    root = pathlib.Path(fixture)
    owned, alias, other = (root / name for name in ('owned', 'alias', 'other'))
    for path in (owned, alias, other, owned / 'nested', other / 'nested'):
        path.mkdir(exist_ok=True)
    file = owned / 'mapped'; file.write_bytes(b'x' * 4096)
    (other / 'nested' / 'other').write_bytes(b'y' * 4096)
    mount('--make-rprivate', '/')
    mount('--bind', str(owned), str(alias))
    libc, mapped, identity = map_file(alias / 'mapped')
    assert_fd_free(identity)
    os.chdir('/')

    def event(case, proc_dir=None):
        # /proc is inherited from the host PID namespace. os.getpid() is namespace-local.
        status = read_bounded('status', proc_dir) if proc_dir is not None else read_bounded('/proc/self/status')
        host_pid = int(next(line for line in status.splitlines() if line.startswith('NSpid:')).split()[1])
        inside = snapshot('self', fixture, proc_dir)
        print(json.dumps({'case': case, 'pid': host_pid, 'inside': inside}), flush=True)
        if case in ('private-bind-closed-fd', 'same-namespace-cwd', 'changed-root'):
            assert_fd_free(identity, proc_dir)
            if not any('/mapped' in line and str(identity[1]) in line.split() for line in inside['maps']):
                raise RuntimeError('expected mapping missing')
        if case in ('nested-overmount', 'changed-root'):
            assert_fd_free(identity, proc_dir); assert_fd_free(nested_identity, proc_dir)
            if not any('/mapped-nested' in line and str(nested_identity[1]) in line.split() for line in inside['maps']):
                raise RuntimeError('expected nested mapping missing')
        if sys.stdin.readline().strip() != 'continue':
            raise RuntimeError('reader did not acknowledge snapshot')

    event('private-bind-closed-fd')
    os.chdir(alias)
    event('same-namespace-cwd')
    os.chdir('/')
    with open(alias / 'mapped', 'rb'):
        event('same-namespace-open-fd')
    (owned / 'nested' / 'mapped-nested').write_bytes(b'z' * 4096)
    _, nested, nested_identity = map_file(alias / 'nested' / 'mapped-nested')
    assert_fd_free(identity); assert_fd_free(nested_identity)
    mount('--bind', str(other / 'nested'), str(alias / 'nested'))
    assert_fd_free(identity); assert_fd_free(nested_identity)
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
    if libc.munmap(nested, 4096) or libc.munmap(mapped, 4096):
        raise OSError(ctypes.get_errno(), 'munmap failed')


def parent_death(expected_parent):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'prctl failed')
    if os.getppid() != expected_parent:
        os._exit(125)


def run_probe(fixture):
    read_end, write_end = os.pipe()
    os.set_inheritable(read_end, True)
    command = ['unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork',
               sys.executable, __file__, '--child', fixture, str(read_end)]
    print(json.dumps({'command': command, 'scope': 'disposable user, mount and PID namespaces'}), flush=True)
    parent_pid = os.getpid()
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            pass_fds=(read_end,), preexec_fn=lambda: parent_death(parent_pid))
    os.close(read_end)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
    deadline = time.monotonic() + 30
    buffers = {'stdout': b'', 'stderr': b''}
    total = 0
    cases = []
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('namespace probe timed out')
            for key, _ in selector.select(remaining):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                total += len(data)
                if total > LIMIT:
                    raise RuntimeError('probe output exceeded byte limit')
                name = key.data
                buffers[name] += data
                if name != 'stdout':
                    continue
                while b'\n' in buffers[name]:
                    line, buffers[name] = buffers[name].split(b'\n', 1)
                    if not line:
                        raise RuntimeError('empty handshake')
                    record = json.loads(line)
                    if 'pid' in record:
                        record['outside'] = snapshot(record['pid'], fixture)
                        cases.append(record['case'])
                        proc.stdin.write(b'continue\n'); proc.stdin.flush()
                    print(json.dumps(record), flush=True)
        if buffers['stdout']:
            raise RuntimeError('incomplete handshake')
        status = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        stderr = buffers['stderr'].decode('utf-8', errors='replace')
        if status:
            unavailable = not cases and ('Operation not permitted' in stderr or 'Permission denied' in stderr)
            print(json.dumps({'capability': 'unavailable' if unavailable else 'failed', 'status': status, 'stderr': stderr}), flush=True)
            if not unavailable:
                raise RuntimeError('namespace probe failed')
        else:
            required = {'private-bind-closed-fd', 'same-namespace-cwd', 'same-namespace-open-fd', 'nested-overmount'}
            if not required.issubset(cases):
                raise RuntimeError('required probe case missing')
            print(json.dumps({'capability': 'available', 'observed_cases': cases, 'stderr': stderr}), flush=True)
    finally:
        # EOF causes namespace init to exit. Wait for unshare to reap init;
        # PID namespace exit has completed before fixture deletion is allowed.
        os.close(write_end)
        proc.stdin.close()
        selector.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise RuntimeError('namespace teardown not verified; fixture retained')
        for stream in (proc.stdout, proc.stderr):
            stream.close()


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        child(sys.argv[2], int(sys.argv[3])); return
    fixture = tempfile.mkdtemp(prefix='cez-mount-probe-')
    try:
        run_probe(fixture)
    except BaseException:
        print(json.dumps({'fixture_retained': fixture}), flush=True)
        raise
    else:
        shutil.rmtree(fixture)


if __name__ == '__main__':
    main()
