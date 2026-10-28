"""Bounded checks for CI-only detachment of a live mapped alias."""
import os
import re


def read_bounded(path):
    with open(path, 'rb') as source: data = source.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024: raise RuntimeError('proc evidence exceeds bound')
    return data.decode('utf-8', errors='strict')


def _mount_path(value):
    def decode(match): return chr(int(match.group(1), 8))
    result = re.sub(r'\\([0-7]{3})', decode, value)
    if '\\' in result or not result.startswith('/'): raise RuntimeError('invalid mount path')
    return result


def check_detached_mounts(mountinfo, alias):
    if len(mountinfo) > 4 * 1024 * 1024: raise RuntimeError('mountinfo exceeds bound')
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 10 or '-' not in fields: raise RuntimeError('invalid mountinfo')
        point = _mount_path(fields[4])
        if point == alias or point.startswith(alias + '/'):
            raise RuntimeError('alias mount remains attached')


def check_mappings(maps, identities):
    if len(maps) > 4 * 1024 * 1024: raise RuntimeError('maps exceeds bound')
    found = set()
    for line in maps.splitlines():
        fields = line.split(None, 5)
        if len(fields) < 5 or not re.fullmatch(r'[0-9a-fA-F]+:[0-9a-fA-F]+', fields[3]) or not fields[4].isdigit():
            raise RuntimeError('invalid maps evidence')
        major, minor = (int(value, 16) for value in fields[3].split(':'))
        found.add((major, minor, int(fields[4])))
    for dev, ino in identities:
        if (os.major(dev), os.minor(dev), ino) not in found: raise RuntimeError('expected mapping missing')


def detach_alias(alias, run, read_mounts, verify):
    run('umount', '-l', alias)
    check_detached_mounts(read_mounts(), alias)
    verify()
