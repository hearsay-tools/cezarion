#!/usr/bin/env python3
"""CI-only lifecycle checks for the same namespace probe supervisor."""
import json
import errno
import os
import pathlib
import runpy
import select
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from unittest.mock import patch

PROBE = pathlib.Path(__file__).with_name('linux-mount-alias-probe.py')
GATES = ('wrapper-before-exec-unshare', 'init-before-mount', 'fork-child-before-chroot')
ORDER = ('controller-start', *GATES)
PRODUCTION = ('controller-start', 'wrapper-before-exec-unshare', 'init-before-mount',
              'production-target-before-setup', 'production-sibling-before-setup', 'production-reader-before-exec')
CAPACITY = ('controller-start', 'wrapper-before-exec-unshare', 'init-before-mount',
            *(f'capacity-child-{index}-before-setup' for index in range(20)), 'capacity-runner-before-exec')
LIMIT = 4 * 1024 * 1024


def alive(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    events = poller.poll(0)
    if any(mask & (select.POLLNVAL | select.POLLERR) or not mask & select.POLLIN for _, mask in events):
        raise RuntimeError('owned pidfd is invalid')
    return not events


def remove_after_teardown(fixture, identity, handles, deadline):
    while waiting := [handle for handle in handles if alive(handle)]:
        if time.monotonic() >= deadline: raise TimeoutError('owned process teardown not verified')
        select.select(waiting, [], [], min(0.1, deadline - time.monotonic()))
    info = os.lstat(fixture)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o777 != 0o700
            or identity != (info.st_dev, info.st_ino)):
        raise RuntimeError('fixture identity or permissions changed')
    shutil.rmtree(fixture)


def run_case(target, signum, action='signal', mode=None, node=None):
    notify_read, notify_write = os.pipe()
    release_read, release_write = os.pipe()
    proc = None
    controller = None
    handles = []
    fixture = None
    fixture_identity = None
    targeted = False
    cleaned = False
    selector = selectors.DefaultSelector()
    buffers = {'gate': b'', 'stdout': b'', 'stderr': b''}
    seen = []
    deadline = time.monotonic() + 45
    try:
        order = PRODUCTION if mode == 'row' else CAPACITY if mode == 'capacity' else ORDER
        args = [sys.executable, str(PROBE), '--gated', str(notify_write), str(release_read)]
        if mode:
            if not node: raise RuntimeError('Node unavailable for production lifecycle')
            args = [sys.executable, str(PROBE), '--gated-production', str(notify_write), str(release_read), node, mode]
        proc = subprocess.Popen(args,
                                pass_fds=(notify_write, release_read), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        controller = os.pidfd_open(proc.pid)
        handles.append(controller)
        os.close(notify_write); notify_write = -1
        os.close(release_read); release_read = -1
        selector.register(notify_read, selectors.EVENT_READ, 'gate')
        selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
        total = 0
        while not (targeted and fixture):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('gate identity not observed')
            for key, _ in selector.select(remaining):
                data = os.read(key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    if key.data == 'gate': raise RuntimeError('gate channel closed before identity')
                    continue
                total += len(data)
                if total > LIMIT: raise RuntimeError('lifecycle output exceeds bounds')
                name = key.data
                buffers[name] += data
                while b'\n' in buffers[name]:
                    line, buffers[name] = buffers[name].split(b'\n', 1)
                    if name == 'stderr': continue
                    record = json.loads(line)
                    if name == 'stdout':
                        if 'fixture' in record:
                            fixture = record['fixture']
                            info = os.lstat(fixture)
                            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o777 != 0o700:
                                raise RuntimeError('fixture identity or permissions invalid')
                            fixture_identity = (info.st_dev, info.st_ino)
                        continue
                    label, pid = record.get('gate'), record.get('pid')
                    if len(seen) >= len(order) or label != order[len(seen)] or not isinstance(pid, int) or pid <= 1:
                        raise RuntimeError('invalid gate identity')
                    if label == 'controller-start':
                        if pid != proc.pid or not alive(controller): raise RuntimeError('controller identity changed')
                    else:
                        if pid == proc.pid: raise RuntimeError('invalid descendant identity')
                        handle = os.pidfd_open(pid)
                        handles.append(handle)
                        if not alive(handle): raise RuntimeError('gate process exited before identity was pinned')
                    seen.append(label)
                    if label == target:
                        targeted = True
                        break
                    if os.write(release_write, b'continue\n') != len(b'continue\n'):
                        raise RuntimeError('gate release failed')
        if action == 'eof':
            os.close(release_write); release_write = -1
        elif action == 'after-release':
            if os.write(release_write, b'continue\n') != len(b'continue\n'):
                raise RuntimeError('gate release failed')
            signal.pidfd_send_signal(controller, signum)
        else:
            signal.pidfd_send_signal(controller, signum)
        proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        if action == 'after-release':
            # A descendant can be created after release and before controller
            # death. Its PID was not gated and pinned, so teardown is unknown.
            print(json.dumps({'gate': target, 'action': action, 'result': 'unverified-retained'}), flush=True)
            return
        remove_after_teardown(fixture, fixture_identity, handles, deadline)
        fixture = None
        cleaned = True
        print(json.dumps({'gate': target, 'action': action, 'signal': signal.Signals(signum).name,
                          'owned_handles_exited': len(handles)}), flush=True)
    finally:
        selector.close()
        if controller is not None and alive(controller):
            try:
                signal.pidfd_send_signal(controller, signal.SIGKILL)
                if proc: proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                print(json.dumps({'teardown': 'controller termination unverified'}), flush=True)
        for fd in handles: os.close(fd)
        for fd in (notify_read, notify_write, release_read, release_write):
            if fd >= 0: os.close(fd)
        if proc:
            for stream in (proc.stdout, proc.stderr):
                if stream: stream.close()
        if fixture:
            print(json.dumps({'fixture_retained': fixture, 'gate': target}), flush=True)
        elif not cleaned:
            print(json.dumps({'fixture_identity': 'unavailable', 'gate': target}), flush=True)


def main():
    if os.geteuid() != 0: raise RuntimeError('private lifecycle CI fixture requires root')
    if len(sys.argv) != 2: raise RuntimeError('expected Node executable')
    node = sys.argv[1]
    failed_teardown_case()
    credential_guard_cases()
    invalid_gate_cases()
    for gate in GATES:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
            run_case(gate, signum)
        run_case(gate, signal.SIGKILL, 'eof')
        run_case(gate, signal.SIGKILL, 'after-release')
    for mode, order in (('row', PRODUCTION), ('capacity', CAPACITY)):
        targets = order[3:] if mode == 'row' else (order[3], order[-1])
        for gate in targets:
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
                run_case(gate, signum, mode=mode, node=node)
            run_case(gate, signal.SIGKILL, 'eof', mode, node)
            run_case(gate, signal.SIGKILL, 'after-release', mode, node)


def failed_teardown_case():
    # Pure injected failure: no process, filesystem or signal is involved.
    global alive
    previous_alive, previous_remove = alive, shutil.rmtree
    removed = []
    try:
        shutil.rmtree = lambda path: removed.append(path)
        def invalid(_handle):
            raise RuntimeError('invalid handle')
        for check, error in ((lambda _handle: True, TimeoutError), (invalid, RuntimeError)):
            alive = check
            try:
                remove_after_teardown('/not-opened', (1, 2), [123], time.monotonic() - 1)
            except error:
                pass
            else:
                raise RuntimeError('failed teardown was accepted')
            if removed: raise RuntimeError('fixture removed after failed teardown')
        print(json.dumps({'teardown': 'live-or-invalid-handle', 'result': 'retained'}), flush=True)
    finally:
        alive, shutil.rmtree = previous_alive, previous_remove


def credential_guard_cases():
    # Inject executable metadata; no process or filesystem is touched.
    guard = runpy.run_path(str(PROBE), run_name='cez_credential_guard')['credential_safe_executable']
    absent = OSError()
    absent.errno = errno.ENODATA
    with patch('shutil.which', return_value='/fixture/tool'), patch('os.path.realpath', side_effect=lambda value: value):
        with patch('os.stat', return_value=type('Info', (), {'st_mode': 0o755})()), patch('os.getxattr', side_effect=absent):
            if guard('tool') != '/fixture/tool': raise RuntimeError('ordinary executable refused')
        for mode in (0o4755, 0o755):
            with patch('os.stat', return_value=type('Info', (), {'st_mode': mode})()), patch('os.getxattr', return_value=b'cap'):
                try:
                    guard('tool')
                except RuntimeError:
                    continue
                raise RuntimeError('credential-changing executable accepted')
    print(json.dumps({'executable': 'credential-change', 'result': 'refused'}), flush=True)


def invalid_gate_cases():
    read_end, write_end = os.pipe()
    try:
        cases = [
            ('missing', ['--gated'], ()),
            ('closed', ['--gated', '999998', '999999'], ()),
            ('forged', ['--gated', str(write_end), str(read_end)], (read_end, write_end)),
        ]
        for name, args, fds in cases:
            proc = subprocess.Popen([sys.executable, str(PROBE), *args], pass_fds=fds,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                stdout, stderr = proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                # This controller owns no descendants before validating the gate.
                handle = os.pidfd_open(proc.pid)
                try:
                    signal.pidfd_send_signal(handle, signal.SIGKILL)
                finally:
                    os.close(handle)
                proc.wait(timeout=5)
                raise RuntimeError('invalid gate controller did not exit')
            if proc.returncode == 0 or b'"fixture"' in stdout or not stderr:
                raise RuntimeError('invalid gate was accepted')
            print(json.dumps({'control': name, 'result': 'refused-before-fixture'}), flush=True)
    finally:
        os.close(read_end); os.close(write_end)


if __name__ == '__main__':
    main()
