// Invoked only for authenticated explicit worker destruction on macOS.
ObjC.import('Foundation');
ObjC.bindFunction('open', ['int', ['char *', 'int', 'int']]);
ObjC.bindFunction('openat', ['int', ['int', 'char *', 'int', 'int']]);
ObjC.bindFunction('fstatat', ['int', ['int', 'char *', 'void *', 'int']]);
ObjC.bindFunction('fstat', ['int', ['int', 'void *']]);
ObjC.bindFunction('fchmodat', ['int', ['int', 'char *', 'int', 'int']]);
ObjC.bindFunction('close', ['int', ['int']]);
ObjC.bindFunction('calloc', ['void *', ['unsigned long', 'unsigned long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
ObjC.bindFunction('__error', ['void *', []]);
function raw(p) { return ObjC.unwrap($.NSData.dataWithBytesLength(p, 512).base64EncodedStringWithOptions(0)); }
function decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let out = [], value = 0, bits = 0;
  for (const ch of s) { if (ch === '=') break; const n = alphabet.indexOf(ch); if (n < 0) throw Error('invalid stat bytes'); value = (value << 6) | n; bits += 6; if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); } }
  return out;
}
function hex(a) { return a.map(x => x.toString(16).padStart(2, '0')).join(''); }
function failure(operation) { const a = decode(ObjC.unwrap($.NSData.dataWithBytesLength($.__error(), 4).base64EncodedStringWithOptions(0))); throw Error(operation + ' errno=' + (a[0] | (a[1] << 8) | (a[2] << 16) | (a[3] << 24))); }
function identity(p) {
  const a = decode(raw(p)); if (a.length !== 512) throw Error('invalid stat size');
  return { dev: hex(a.slice(0, 4)), ino: hex(a.slice(8, 16)), mode: a[4] | (a[5] << 8) };
}
function validateArgs(args) {
  if (args.length !== 4 || !args[0] || !args[1] || args[0].includes('\0') || args[1].includes('\0') || args[1].includes('/') || args[1] === '.' || args[1] === '..' || !/^[0-9a-f]{8}$/.test(args[2]) || !/^[0-9a-f]{16}$/.test(args[3])) throw Error('invalid directory arguments');
}
function run(args) {
  validateArgs(args);
  const parentString = $(args[0]), nameString = $(args[1]);
  const parent = parentString.UTF8String, name = nameString.UTF8String;
  const fd = $.open(parent, 0x60100000, 0); if (fd < 0) failure('open parent');
  const pre = $.calloc(1, 512), post = $.calloc(1, 512); let child = -1;
  try {
    if (!pre || !post) throw Error('allocation failed');
    if ($.fstatat(fd, name, pre, 0x800) !== 0) failure('fstatat');
    const before = identity(pre);
    if (before.dev !== args[2] || before.ino !== args[3] || (before.mode & 0xf000) !== 0x4000) throw Error('directory identity mismatch');
    if ($.fchmodat(fd, name, (before.mode & 0o7777) | 0o700, 0x800) !== 0) failure('fchmodat');
    child = $.openat(fd, name, 0x20100000, 0); if (child < 0) failure('reopen');
    if ($.fstat(child, post) !== 0) failure('fstat');
    const after = identity(post);
    if (after.dev !== before.dev || after.ino !== before.ino || (after.mode & 0xf000) !== 0x4000) throw Error('directory identity mismatch after chmod');
    return 'ok';
  } finally { if (child >= 0) $.close(child); if (pre) $.free(pre); if (post) $.free(post); $.close(fd); }
}
