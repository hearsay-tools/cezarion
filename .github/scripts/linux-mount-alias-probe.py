#!/usr/bin/env python3
"""Observe proc paths in disposable Linux mount and PID namespaces."""
import json
import ctypes
import errno
import fcntl
import os
import pathlib
import selectors
import select
import subprocess
import sys
import tempfile
import shutil
import signal
import stat
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
        result['map_files'] = {}
        if len(result['maps']) > 1024:
            result['map_files']['error'] = 'mapping count exceeds observation limit'
        for line in result['maps'][:1024]:
            address = line.split(' ', 1)[0]
            name = path('map_files/' + address)
            try:
                info = os.stat(name, dir_fd=directory)
                result['map_files'][address] = {'path': os.readlink(name, dir_fd=directory),
                                                'dev': info.st_dev, 'ino': info.st_ino}
            except OSError as error:
                result['map_files'][address] = {'error': f'{error.__class__.__name__}: {error}'}
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


def verify_private_fixture(fixture, parent_mount_ns):
    root = pathlib.Path(fixture)
    info = os.lstat(root)
    if (os.geteuid() != 0 or os.getpid() != 1 or os.readlink('/proc/self/ns/mnt') == parent_mount_ns
            or info.st_uid != 0 or info.st_mode & 0o777 != 0o700 or not root.is_dir() or root.is_symlink()):
        raise RuntimeError('private namespace or fixture ownership not verified')
    return root


def gate(label, notify_fd, release_fd, outer_proc=None):
    if notify_fd < 0 or release_fd < 0:
        if notify_fd != -1 or release_fd != -1:
            raise RuntimeError('invalid gate handles')
        return
    if notify_fd <= 2 or release_fd <= 2 or notify_fd == release_fd:
        raise RuntimeError('invalid gate handles')
    notify_info, release_info = os.fstat(notify_fd), os.fstat(release_fd)
    if (not stat.S_ISFIFO(notify_info.st_mode) or not stat.S_ISFIFO(release_info.st_mode)
            or (notify_info.st_dev, notify_info.st_ino) == (release_info.st_dev, release_info.st_ino)
            or fcntl.fcntl(notify_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_WRONLY
            or fcntl.fcntl(release_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY):
        raise RuntimeError('invalid gate handles')
    status = read_bounded('self/status', outer_proc) if outer_proc is not None else read_bounded('/proc/self/status')
    if not isinstance(status, str):
        raise RuntimeError('gate identity unavailable')
    host_pid = int(next(line for line in status.splitlines() if line.startswith('NSpid:')).split()[1])
    record = (json.dumps({'gate': label, 'pid': host_pid}) + '\n').encode()
    if len(record) > 4096 or os.write(notify_fd, record) != len(record):
        raise RuntimeError('incomplete gate record')
    deadline = time.monotonic() + 10
    data = b''
    while not data.endswith(b'\n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([release_fd], [], [], remaining)[0]:
            raise TimeoutError('gate release timed out')
        byte = os.read(release_fd, 1)
        if not byte or len(data) >= 32:
            raise RuntimeError('invalid gate release')
        data += byte
    if data != b'continue\n':
        raise RuntimeError('invalid gate release')


def child(fixture, lifeline, parent_mount_ns, notify_fd, release_fd, production_node=None, parent_pid_ns=None, proof=None):
    # A closed lifeline must be observed before any mount or fork. No child
    # receives a writer, so later controller death also produces EOF.
    if select.select([lifeline], [], [], 0)[0]:
        if not os.read(lifeline, 1):
            os._exit(125)
        raise RuntimeError('unexpected lifeline data')
    watching = threading.Event()
    def watch_parent():
        try:
            watching.set()
            os.read(lifeline, 1)
        finally:
            os._exit(125)  # PID namespace init exit tears down every descendant.
    threading.Thread(target=watch_parent, daemon=True).start()
    if not watching.wait(5):
        raise RuntimeError('lifeline watcher did not start')

    root = verify_private_fixture(fixture, parent_mount_ns)
    gate('init-before-mount', notify_fd, release_fd)
    if production_node:
        from linux_reaper_fixture import production_rows
        production_rows(root, production_node, parent_pid_ns, parent_mount_ns, proof == '--proof',
                        (lambda label, outer: gate(label, notify_fd, release_fd, outer)) if notify_fd >= 0 else None,
                        proof == '--capacity-gate', (notify_fd, release_fd) if notify_fd >= 0 else ())
        return
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
        if case in ('private-bind-closed-fd', 'same-namespace-cwd', 'changed-root', 'alias-unmounted-after-map'):
            assert_fd_free(identity, proc_dir)
            if not any('/mapped' in line and str(identity[1]) in line.split() for line in inside['maps']):
                raise RuntimeError('expected mapping missing')
        if case in ('nested-overmount', 'changed-root', 'alias-unmounted-after-map'):
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
            gate('fork-child-before-chroot', notify_fd, release_fd)
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
    subprocess.run(['umount', str(alias / 'nested')], check=True, timeout=10)
    subprocess.run(['umount', str(alias)], check=True, timeout=10)
    event('alias-unmounted-after-map')
    if libc.munmap(nested, 4096) or libc.munmap(mapped, 4096):
        raise OSError(ctypes.get_errno(), 'munmap failed')


def parent_death(expected_parent):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'prctl failed')
    if os.getppid() != expected_parent:
        os._exit(125)


def credential_safe_executable(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError('executable unavailable')
    path = os.path.realpath(path)
    if os.stat(path).st_mode & 0o6000:
        raise RuntimeError('credential-changing executable')
    try:
        os.getxattr(path, 'security.capability')
    except OSError as error:
        if error.errno not in (errno.ENODATA, errno.ENOTSUP):
            raise
    else:
        raise RuntimeError('executable has file capabilities')
    return path


def run_probe(fixture, notify_fd=-1, release_fd=-1, observer=None, production_node=None, proof=False, capacity_gate=False):
    credential_safe_executable(sys.executable)
    if observer: observer = credential_safe_executable(observer)
    if production_node: production_node = credential_safe_executable(production_node)
    read_end, write_end = os.pipe()
    os.set_inheritable(read_end, True)
    parent_mount_ns = os.readlink('/proc/self/ns/mnt')
    parent_pid_ns = os.readlink('/proc/self/ns/pid')
    command = [sys.executable, __file__, '--bootstrap', fixture, str(read_end), parent_mount_ns,
               str(os.getpid()), str(notify_fd), str(release_fd)]
    if production_node:
        command += [production_node, parent_pid_ns]
        if proof: command.append('--proof')
        if capacity_gate: command.append('--capacity-gate')
    print(json.dumps({'command': command, 'scope': 'existing user namespace; disposable mount and PID namespaces'}), flush=True)
    parent_pid = os.getpid()
    gate_fds = (notify_fd, release_fd) if notify_fd >= 0 and release_fd >= 0 else ()
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            pass_fds=(read_end, *gate_fds), preexec_fn=lambda: parent_death(parent_pid))
    os.close(read_end)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
    deadline = time.monotonic() + (240 if production_node else 30)
    buffers = {'stdout': b'', 'stderr': b''}
    total = 0
    cases = []
    production_complete = False
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
                    if record.get('productionComplete') is True:
                        production_complete = True
                    if 'pid' in record:
                        record['outside'] = snapshot(record['pid'], fixture)
                        if observer:
                            script = pathlib.Path(__file__).with_name('linux-mount-alias-observer.mjs')
                            observed = subprocess.run([observer, '--experimental-transform-types', str(script),
                                                       str(pathlib.Path(fixture) / 'owned'), str(record['pid']), record['case']],
                                                      capture_output=True, text=True, timeout=10)
                            if observed.returncode:
                                raise RuntimeError('production observer failed: ' + observed.stderr[-4096:])
                            record['production_observer'] = json.loads(observed.stdout)
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
            raise RuntimeError('namespace capability unavailable' if unavailable else 'namespace probe failed')
        else:
            required = {'private-bind-closed-fd', 'same-namespace-cwd', 'same-namespace-open-fd', 'nested-overmount', 'alias-unmounted-after-map'}
            if not production_node and not required.issubset(cases):
                raise RuntimeError('required probe case missing')
            if production_node and not production_complete:
                raise RuntimeError('production rows incomplete')
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
    if len(sys.argv) in (8, 10, 11) and sys.argv[1] == '--bootstrap':
        fixture, lifeline, mount_ns, parent, notify, release = sys.argv[2:8]
        extra = sys.argv[8:]
        parent_death(int(parent))
        gate('wrapper-before-exec-unshare', int(notify), int(release))
        executable = credential_safe_executable('unshare')
        for fd in (int(lifeline), int(notify), int(release)):
            if fd >= 0: os.set_inheritable(fd, True)
        os.execv(executable, [executable, '--mount', '--pid', '--fork', sys.executable, __file__,
                              '--child', fixture, lifeline, mount_ns, notify, release, *extra])
    if len(sys.argv) in (7, 9, 10) and sys.argv[1] == '--child':
        child(sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6]),
              *sys.argv[7:]); return
    observer = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == '--observer' else None
    gated_production = len(sys.argv) == 6 and sys.argv[1] == '--gated-production' and sys.argv[5] in ('row', 'capacity')
    production_node = sys.argv[4] if gated_production else (sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] in ('--production', '--production-proof') else None)
    proof = len(sys.argv) == 3 and sys.argv[1] == '--production-proof'
    if (len(sys.argv) not in (1, 4) and observer is None and production_node is None) or (len(sys.argv) == 4 and sys.argv[1] != '--gated'):
        raise RuntimeError('invalid probe arguments')
    notify_fd, release_fd = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) == 4 or gated_production else (-1, -1)
    if (notify_fd < 0) != (release_fd < 0):
        raise RuntimeError('invalid gate handles')
    gate('controller-start', notify_fd, release_fd)
    fixture = tempfile.mkdtemp(prefix='cez-mount-probe-')
    print(json.dumps({'fixture': fixture}), flush=True)
    try:
        run_probe(fixture, notify_fd, release_fd, observer, production_node, proof, gated_production and sys.argv[5] == 'capacity')
    except BaseException:
        print(json.dumps({'fixture_retained': fixture}), flush=True)
        raise
    else:
        shutil.rmtree(fixture)


if __name__ == '__main__':
    main()
