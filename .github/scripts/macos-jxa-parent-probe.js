// Diagnostic only. Pass a disposable parent, single child name and octal mode.
// Do not use on a real workspace. Output is evidence, not an authorization check.
ObjC.import('Foundation');
ObjC.bindFunction('open', ['int', ['char *', 'int', 'int']]);
ObjC.bindFunction('fstatat', ['int', ['int', 'char *', 'void *', 'int']]);
ObjC.bindFunction('fchmodat', ['int', ['int', 'char *', 'int', 'int']]);
ObjC.bindFunction('close', ['int', ['int']]);
ObjC.bindFunction('calloc', ['void *', ['unsigned long', 'unsigned long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
ObjC.bindFunction('__error', ['void *', []]);
function bytes(p, n) {
  return ObjC.unwrap($.NSData.dataWithBytesLength(p, n).base64EncodedStringWithOptions(0));
}
function run(args) {
  if (args.length !== 3 || !/^[0-7]{1,4}$/.test(args[2]) || !args[1] || args[0].includes('\0') || args[1].includes('\0') || args[1] === '.' || args[1] === '..' || args[1].includes('/')) throw Error('Expected disposable parent, child name, octal mode');
  const parentString = $(args[0]), nameString = $(args[1]);
  const parent = parentString.UTF8String;
  const name = nameString.UTF8String;
  const fd = $.open(parent, 0x60100000, 0); // O_SEARCH | O_NOFOLLOW_ANY
  const result = { argv: args, fd, openErrnoBytesOnFailure: fd < 0 ? bytes($.__error(), 4) : null };
  if (fd < 0) return JSON.stringify(result);
  const pre = $.calloc(1, 512), post = $.calloc(1, 512);
  if (!pre || !post) { if (pre) $.free(pre); if (post) $.free(post); $.close(fd); throw Error('calloc failed'); }
  try {
    result.before = $.fstatat(fd, name, pre, 0x800);
    result.beforeErrnoBytesOnFailure = result.before < 0 ? bytes($.__error(), 4) : null;
    result.beforeStatBytes = bytes(pre, 512);
    if (result.before === 0) {
      result.chmod = $.fchmodat(fd, name, parseInt(args[2], 8), 0x800);
      result.chmodErrnoBytesOnFailure = result.chmod < 0 ? bytes($.__error(), 4) : null;
      result.after = $.fstatat(fd, name, post, 0x800);
      result.afterErrnoBytesOnFailure = result.after < 0 ? bytes($.__error(), 4) : null;
      result.afterStatBytes = bytes(post, 512);
    }
  } finally { $.free(pre); $.free(post); $.close(fd); }
  return JSON.stringify(result);
}
