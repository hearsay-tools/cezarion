/** Injected only into the private test fixture, after the helper validates the original. */
export function preChmodRaceFixture(source: string, saved: string, replacement: string): string {
  const marker = 'if ($.fchmodat(fd, name,';
  if (source.split(marker).length !== 2 || source.split('function run(args) {').length !== 2) throw Error('fixture marker changed');
  const binding = "ObjC.bindFunction('renameat', ['int', ['int', 'char *', 'int', 'char *']]);\nObjC.bindFunction('mkdirat', ['int', ['int', 'char *', 'int']]);\nObjC.bindFunction('symlinkat', ['int', ['char *', 'int', 'char *']]);\nObjC.bindFunction('fchmod', ['int', ['int', 'int']]);\n";
  const hook = `{
    if ((before.mode & 0o7777) !== 0) throw Error('fixture original mode');
    if ($.fchmodat(fd, name, (before.mode & 0o7777) | 0o700, 0x800) !== 0) failure('fixture grant fchmodat');
    let fixtureFd = -1; const fixtureStat = $.calloc(1, 512), savedStat = $.calloc(1, 512);
    try {
      if (!fixtureStat || !savedStat) throw Error('fixture allocation failed');
      fixtureFd = $.openat(fd, name, 0x20100000, 0); if (fixtureFd < 0) failure('fixture openat');
      if ($.fstat(fixtureFd, fixtureStat) !== 0) failure('fixture fstat granted');
      const granted = identity(fixtureStat);
      if (granted.dev !== before.dev || granted.ino !== before.ino || (granted.mode & 0xf000) !== (before.mode & 0xf000) || (granted.mode & 0o7777) !== ((before.mode & 0o7777) | 0o700)) throw Error('fixture granted identity');
      if ($.renameat(fd, name, fd, $(${JSON.stringify(saved)}).UTF8String) !== 0) failure('fixture renameat');
      if ($.fchmod(fixtureFd, before.mode & 0o7777) !== 0) failure('fixture restore fchmod');
      if ($.fstat(fixtureFd, fixtureStat) !== 0) failure('fixture fstat restored');
      const restored = identity(fixtureStat);
      if (restored.dev !== before.dev || restored.ino !== before.ino || (restored.mode & 0xf000) !== (before.mode & 0xf000) || (restored.mode & 0o7777) !== 0) throw Error('fixture restored identity');
      if ($.fstatat(fd, $(${JSON.stringify(saved)}).UTF8String, savedStat, 0x800) !== 0) failure('fixture saved fstatat');
      const savedBefore = identity(savedStat);
      if (savedBefore.dev !== restored.dev || savedBefore.ino !== restored.ino || savedBefore.mode !== restored.mode) throw Error('fixture saved identity');
      ${replacement}
      if ($.fstatat(fd, $(${JSON.stringify(saved)}).UTF8String, savedStat, 0x800) !== 0) failure('fixture boundary fstatat');
      const savedAfter = identity(savedStat);
      if (savedAfter.dev !== restored.dev || savedAfter.ino !== restored.ino || savedAfter.mode !== restored.mode) throw Error('fixture boundary identity');
    } finally { if (fixtureFd >= 0) $.close(fixtureFd); if (fixtureStat) $.free(fixtureStat); if (savedStat) $.free(savedStat); }
  }
    `;
  return source.replace('function run(args) {', binding + 'function run(args) {').replace(marker, hook + marker);
}
