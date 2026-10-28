import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { relative, sep } from 'node:path';

// Linux O_PATH opens an object without opening its contents. Node does not
// expose this Linux-only flag in fs.constants.
const O_PATH = 0x200000;

export interface LinuxFileIdentity { dev: bigint; ino: bigint }

export function linuxDeviceNumber(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return major.toString() + ':' + minor.toString();
}

/** Pin every directory while descending. O_PATH|O_NOFOLLOW can itself open a
 * symlink, so each opened object is checked before it can be used. */
export function pinnedAliasIdentity(root: string, candidate: string, expectedRoot?: string): LinuxFileIdentity {
  const tail = relative(root, candidate);
  const parts = tail ? tail.split(sep) : [];
  if (parts.length > 256 || parts.some(part => !part || part === '.' || part === '..') || tail.startsWith('..' + sep)) {
    throw new Error('alias candidate outside root');
  }
  const held: number[] = [];
  try {
    let fd = openSync(root, O_PATH | constants.O_NOFOLLOW);
    held.push(fd);
    let stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('alias root is not a directory');
    if (expectedRoot && `${stat.dev}:${stat.ino}` !== expectedRoot) throw new Error('alias root identity changed');
    for (const [index, part] of parts.entries()) {
      fd = openSync('/proc/self/fd/' + fd + '/' + part, O_PATH | constants.O_NOFOLLOW);
      held.push(fd);
      stat = fstatSync(fd, { bigint: true });
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('redirected alias candidate');
    }
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    for (const fd of held.reverse()) closeSync(fd);
  }
}
