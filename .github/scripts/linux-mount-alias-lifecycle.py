#!/usr/bin/env python3
"""CI-only lifecycle checks for the same namespace probe supervisor."""
import json
import os
import pathlib
import select
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time

PROBE = pathlib.Path(__file__).with_name('linux-mount-alias-probe.py')
GATES = ('wrapper-before-exec-unshare', 'init-before-mount', 'fork-child-before-chroot')
ORDER = ('controller-start', *GATES)
LIMIT = 4 * 1024 * 1024


def alive(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    events = poller.poll(0)
    if any(mask & (select.POLLNVAL | select.POLLERR) or not mask & select.POLLIN for _, mask in events):
        raise RuntimeError('owned pidfd is invalid')
    return not events


def run_case(target, signum, action='signal'):
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
        proc = subprocess.Popen([sys.executable, str(PROBE), '--gated', str(notify_write), str(release_read)],
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
                    if len(seen) >= len(ORDER) or label != ORDER[len(seen)] or not isinstance(pid, int) or pid <= 1:
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
        while waiting := [handle for handle in handles if alive(handle)]:
            if time.monotonic() >= deadline: raise TimeoutError('owned process teardown not verified')
            select.select(waiting, [], [], min(0.1, deadline - time.monotonic()))
        if action == 'after-release':
            # A descendant can be created after release and before controller
            # death. Its PID was not gated and pinned, so teardown is unknown.
            print(json.dumps({'gate': target, 'action': action, 'result': 'unverified-retained'}), flush=True)
            return
        info = os.lstat(fixture)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o777 != 0o700
                or fixture_identity != (info.st_dev, info.st_ino)):
            raise RuntimeError('fixture identity or permissions changed')
        shutil.rmtree(fixture)
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
    invalid_gate_cases()
    for gate in GATES:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
            run_case(gate, signum)
        run_case(gate, signal.SIGKILL, 'eof')
        run_case(gate, signal.SIGKILL, 'after-release')


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
