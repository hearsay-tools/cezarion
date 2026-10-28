"""CI-only rows run by the namespace probe's existing PID 1 supervisor."""
import ctypes
import json
import os
import pathlib
import pwd
import select
import selectors
import shutil
import signal
import stat
import subprocess
import time
import uuid

LIMIT = 65536
DRIVER = pathlib.Path(__file__).with_name('linux-reaper-regression.mjs')
CASES = ('private-bind-closed-fd', 'same-namespace-cwd', 'same-namespace-open-fd',
         'nested-overmount', 'changed-root', 'detached-alias', 'restricted-user')


def command(*args):
    subprocess.run(args, check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def bounded_line(fd):
    data = b''
    deadline = time.monotonic() + 10
    while not data.endswith(b'\n'):
        if len(data) >= LIMIT or time.monotonic() >= deadline or not select.select([fd], [], [], 1)[0]:
            if time.monotonic() >= deadline or len(data) >= LIMIT: raise RuntimeError('child handshake unavailable')
            continue
        part = os.read(fd, 1)
        if not part: raise RuntimeError('child handshake closed')
        data += part
    return json.loads(data)


def alive(pidfd):
    poll = select.poll(); poll.register(pidfd, select.POLLIN)
    events = poll.poll(0)
    if any(mask & (select.POLLNVAL | select.POLLERR) or not mask & select.POLLIN for _, mask in events):
        raise RuntimeError('invalid process handle')
    return not events


def token(pid):
    value = pathlib.Path(f'/proc/{pid}/stat').read_text()
    fields = value[value.rfind(')') + 1:].split()
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]


def outer_pid(outer_proc):
    fd = os.open('self/status', os.O_RDONLY, dir_fd=outer_proc)
    try:
        content = os.read(fd, LIMIT).decode()
        values = next(line for line in content.splitlines() if line.startswith('NSpid:')).split()[1:]
        if not values or int(values[-1]) != os.getpid(): raise RuntimeError('PID namespace identity changed')
        return int(values[0])
    finally: os.close(fd)


def identity(pid, outer, uid):
    root = os.stat(f'/proc/{pid}/root')
    status = pathlib.Path(f'/proc/{pid}/status').read_text()
    actual_uid = int(next(line for line in status.splitlines() if line.startswith('Uid:')).split()[1])
    if actual_uid != uid: raise RuntimeError('target UID changed')
    return {'pid': pid, 'outerPid': outer, 'startToken': token(pid), 'uid': uid,
            'mountNamespace': os.readlink(f'/proc/{pid}/ns/mnt'),
            'rootIdentity': {'dev': str(root.st_dev), 'ino': str(root.st_ino)}}


def drop(uid, gid):
    if uid:
        os.setgroups([]); os.setgid(gid); os.setuid(uid)
        if ctypes.CDLL(None, use_errno=True).prctl(4, 1, 0, 0, 0): raise RuntimeError('cannot set dumpable')
        status = pathlib.Path('/proc/self/status').read_text()
        caps = next(line for line in status.splitlines() if line.startswith('CapEff:')).split()[1]
        if int(caps, 16): raise RuntimeError('restricted process retains capabilities')


def mapped(path):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long)
    libc.munmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t)
    fd = os.open(path, os.O_RDONLY)
    try: address = libc.mmap(None, 4096, 1, 2, fd, 0)
    finally: os.close(fd)
    if address == ctypes.c_void_p(-1).value: raise OSError(ctypes.get_errno(), 'mmap failed')
    return libc, address


def child_process(kind, case, row, uid, gid, outer_proc, control, ready):
    try:
        drop(uid, gid)
        handle = None; mapping = None
        alias = row / 'alias'
        if kind == 'target':
            if case == 'same-namespace-cwd': os.chdir(alias)
            elif case == 'same-namespace-open-fd': handle = open(alias / 'mapped', 'rb')
            else:
                path = alias / ('nested/mapped' if case == 'nested-overmount' else 'mapped')
                mapping = mapped(path)
            if case == 'changed-root': os.chroot(row); os.chdir('/')
        os.write(ready, (json.dumps({'outerPid': outer_pid(outer_proc), 'pid': os.getpid()}) + '\n').encode())
        while True:
            message = os.read(control, 1)
            if not message: break
            if message == b'r':
                if mapping and mapping[0].munmap(mapping[1], 4096): raise RuntimeError('munmap failed')
                mapping = None
                os.write(ready, b'{"released":true}\n')
            elif message == b'x': break
            else: raise RuntimeError('invalid child command')
        if handle: handle.close()
        os._exit(0)
    except BaseException:
        os._exit(125)


def spawn_child(kind, case, row, uid, gid, outer_proc):
    control_r, control_w = os.pipe(); ready_r, ready_w = os.pipe()
    pid = os.fork()
    if not pid:
        os.close(control_w); os.close(ready_r)
        child_process(kind, case, row, uid, gid, outer_proc, control_r, ready_w)
    os.close(control_r); os.close(ready_w)
    handle = os.pidfd_open(pid)
    report = bounded_line(ready_r)
    if report.get('pid') != pid or not alive(handle): raise RuntimeError('child identity unavailable')
    return {'pid': pid, 'outer': report['outerPid'], 'handle': handle, 'control': control_w, 'ready': ready_r}


def finish(child):
    if alive(child['handle']): signal.pidfd_send_signal(child['handle'], signal.SIGTERM)
    deadline = time.monotonic() + 10
    while alive(child['handle']):
        if time.monotonic() >= deadline: raise RuntimeError('child teardown unverified')
        select.select([child['handle']], [], [], 0.1)
    os.waitpid(child['pid'], 0)
    for key in ('handle', 'control', 'ready'): os.close(child[key])


def driver_output(node, data, uid, gid):
    proc = subprocess.Popen([node, '--experimental-transform-types', str(DRIVER)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            preexec_fn=(lambda: drop(uid, gid)) if uid else None)
    selector = selectors.DefaultSelector()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    deadline = time.monotonic() + 15
    try:
        proc.stdin.write(data); proc.stdin.close()
        selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('reaper driver timed out')
            for key, _ in selector.select(remaining):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj); continue
                output[key.data].extend(chunk)
                if len(output[key.data]) > LIMIT: raise RuntimeError('reaper output exceeds bound')
        code = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        return code, bytes(output['stdout']), bytes(output['stderr'])
    finally:
        selector.close()
        if proc.poll() is None:
            proc.kill(); proc.wait(timeout=5)
        proc.stdout.close(); proc.stderr.close()


def invoke(node, row, action, target, sibling, uid, gid):
    request = {**row, 'action': action, 'target': identity(target['pid'], target['outer'], uid),
               'sibling': identity(sibling['pid'], sibling['outer'], uid)}
    data = (json.dumps(request) + '\n').encode()
    if len(data) > LIMIT: raise RuntimeError('row exceeds bound')
    code, stdout, stderr = driver_output(node, data, uid, gid)
    if not stdout.endswith(b'\n') or stdout.count(b'\n') != 1:
        raise RuntimeError('invalid reaper output framing')
    if code == 42 and action == 'stop':
        response = json.loads(stdout)
        if response.get('code') == 'holder-survived-reap':
            print(json.dumps({'reaperExit': 42, 'code': response['code'], 'case': row['case']}), flush=True)
    if code:
        raise RuntimeError('reaper row failed: ' + stderr[-4096:].decode(errors='replace'))
    response = json.loads(stdout)
    if (response.get('version') != 1 or response.get('status') != 'passed' or response.get('case') != row['case']
            or response.get('action') != action or response.get('resourceKind') != row['resourceKind']
            or not isinstance(response.get('code'), str) or not isinstance(response.get('allowDelete'), bool)
            or not isinstance(response.get('checkpointRetained'), bool)
            or not isinstance(response.get('elapsedMs'), (int, float)) or response['elapsedMs'] < 0):
        raise RuntimeError('invalid reaper response')
    for key in ('target', 'sibling'):
        if any(response.get(key, {}).get(name) != request[key][name] for name in ('pid', 'outerPid', 'startToken')):
            raise RuntimeError('reaper returned a different process identity')
    return response


def row_case(root, node, outer_proc, outer_pid_ns, outer_mount_ns, case, resource_kind, uid, gid):
    row = root / (case + '-' + resource_kind)
    row.mkdir(mode=0o700)
    resource = row / ('owned' if resource_kind == 'worktree' else 'scratch')
    alias = row / 'alias'; sibling_path = row / 'sibling'; other = row / 'other'
    for path in (resource, alias, sibling_path, other, resource / 'nested', other / 'nested'): path.mkdir()
    (resource / 'mapped').write_bytes(b'x' * 4096)
    (resource / 'nested' / 'mapped').write_bytes(b'y' * 4096)
    (other / 'nested' / 'other').write_bytes(b'z' * 4096)
    if uid:
        for path in [row, *row.rglob('*')]: os.chown(path, uid, gid)
    row_id = os.stat(row)
    resource_id = os.stat(resource)
    command('mount', '--bind', str(resource), str(alias))
    target = sibling = None
    detached = False; nested = False
    try:
        target = spawn_child('target', case, row, uid, gid, outer_proc)
        sibling = spawn_child('sibling', case, row, uid, gid, outer_proc)
        if case == 'nested-overmount':
            command('mount', '--bind', str(other / 'nested'), str(alias / 'nested')); nested = True
        request = {'version': 1, 'case': case, 'resourceKind': resource_kind, 'fixtureRoot': str(row),
                   'resourceRoot': str(resource), 'generation': str(uuid.uuid4()), 'resourceId': str(uuid.uuid4()),
                   'readerUid': uid, 'namespace': {'pid': os.readlink('/proc/self/ns/pid'), 'mount': os.readlink('/proc/self/ns/mnt'),
                   'outerPid': outer_pid_ns, 'outerMount': outer_mount_ns, 'initStartToken': token(1)}}
        actions = ('seed', 'retain', 'retain', 'release') if case == 'detached-alias' else ('observe', 'stop')
        for action in actions:
            if action == 'retain' and not detached:
                command('umount', str(alias)); detached = True
            if action == 'release':
                os.write(target['control'], b'r')
                if bounded_line(target['ready']).get('released') is not True: raise RuntimeError('release unverified')
            response = invoke(node, request, action, target, sibling, uid, gid)
            if not alive(sibling['handle']): raise RuntimeError('unrelated sibling exited')
            target_alive = alive(target['handle'])
            if response.get('target', {}).get('alive') is not target_alive or response.get('sibling', {}).get('alive') is not True:
                raise RuntimeError('reaper liveness disagrees with pinned handles')
            if action == 'stop' and (target_alive or not response.get('allowDelete')): raise RuntimeError('stop not proven')
            if action in ('observe', 'seed', 'retain', 'release') and not target_alive: raise RuntimeError('target exited before release proof')
            if action == 'observe' and response.get('allowDelete'): raise RuntimeError('live holder reported clear')
            if action in ('seed', 'retain') and (response.get('allowDelete') or not response.get('checkpointRetained')):
                raise RuntimeError('retention not proven')
            if action == 'release' and (not response.get('allowDelete') or response.get('checkpointRetained')):
                raise RuntimeError('release not proven')
            print(json.dumps({'productionRow': case, 'resourceKind': resource_kind, 'action': action, 'result': response}), flush=True)
        finish(target); target = None
        finish(sibling); sibling = None
        if nested: command('umount', str(alias / 'nested')); nested = False
        if not detached: command('umount', str(alias)); detached = True
        current = os.lstat(row)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (row_id.st_dev, row_id.st_ino):
            raise RuntimeError('row identity changed')
        current_resource = os.lstat(resource)
        if not stat.S_ISDIR(current_resource.st_mode) or (current_resource.st_dev, current_resource.st_ino) != (resource_id.st_dev, resource_id.st_ino):
            raise RuntimeError('resource identity changed')
        shutil.rmtree(row)
    finally:
        # Failure retains the row; namespace init exit tears down its children.
        for child in (target, sibling):
            if child:
                for key in ('handle', 'control', 'ready'): os.close(child[key])


def production_rows(root, node, outer_pid_ns, outer_mount_ns):
    outer_proc = os.open('/proc', os.O_RDONLY | os.O_DIRECTORY)
    try:
        command('mount', '--make-rprivate', '/')
        command('mount', '-t', 'proc', 'proc', '/proc')
        if os.readlink('/proc/self/ns/pid') == outer_pid_ns: raise RuntimeError('PID namespace not private')
        if pathlib.Path('/proc/self/stat').read_text().split(' ', 1)[0] != '1':
            raise RuntimeError('proc does not match the private PID namespace')
        mounts = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
        if any(any(field.startswith(('shared:', 'master:')) for field in line.split(' - ', 1)[0].split()) for line in mounts):
            raise RuntimeError('mount namespace propagation is not private')
        for case in CASES:
            uid = gid = 0
            if case == 'restricted-user':
                account = pwd.getpwnam('nobody'); uid, gid = account.pw_uid, account.pw_gid
                if not uid: raise RuntimeError('restricted UID unavailable')
                os.chown(root, uid, gid)
            try:
                for resource_kind in ('worktree', 'scratch'):
                    row_case(root, node, outer_proc, outer_pid_ns, outer_mount_ns, case, resource_kind, uid, gid)
            finally:
                if uid: os.chown(root, 0, 0)
        print(json.dumps({'productionComplete': True}), flush=True)
    finally: os.close(outer_proc)
