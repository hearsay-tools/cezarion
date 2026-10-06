import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compressHistory,
  historyPaths,
  openHistorySource,
  readHistoryText,
  removeHistory,
  restoreHistory,
} from './history-file.ts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function transcript(n = 2000): string {
  return Array.from({ length: n }, (_, i) => JSON.stringify({ seq: i + 1, type: 'note', message: `line ${i}` })).join('\n') + '\n';
}

function setup(): { dataDir: string; id: string; plain: string; compressed: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-history-file-'));
  dirs.push(dataDir);
  const id = randomUUID();
  mkdirSync(join(dataDir, 'runs'));
  const plain = join(dataDir, 'runs', `${id}.ndjson`);
  return { dataDir, id, plain, compressed: `${plain}.br` };
}

function leftoverTmp(dataDir: string): string[] {
  return readdirSync(join(dataDir, 'runs')).filter((name) => name.endsWith('.tmp'));
}

function br(data: string | Buffer): Buffer {
  return brotliCompressSync(Buffer.from(data), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('history-file', () => {
  it('round-trips a transcript byte for byte', async () => {
    const { dataDir, id, plain, compressed } = setup();
    const original = transcript();
    writeFileSync(plain, original);
    expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(compressed)).toBe(true);
    expect(leftoverTmp(dataDir)).toEqual([]);
    expect(readHistoryText(dataDir, id)).toBe(original);
  });

  it('restore writes the original bytes back', async () => {
    const { dataDir, id, plain, compressed } = setup();
    const original = Buffer.from(transcript());
    writeFileSync(plain, original);
    expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
    restoreHistory(dataDir, id);
    expect(readFileSync(plain).equals(original)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
    expect(leftoverTmp(dataDir)).toEqual([]);
  });

  it('drops the .br when both exist and the decoded bytes are a prefix of the plain file', () => {
    const { dataDir, id, plain, compressed } = setup();
    const body = Buffer.from('ABCDEF');
    writeFileSync(plain, body);
    writeFileSync(
      compressed,
      brotliCompressSync(body.subarray(0, 3), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }),
    );
    expect(readHistoryText(dataDir, id)).toBe('ABCDEF');
    restoreHistory(dataDir, id);
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
    expect(readFileSync(plain, 'utf8')).toBe('ABCDEF');
  });

  it('orphans the .br when both exist and the decoded bytes are not a prefix', () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'A');
    const encodedB = brotliCompressSync(Buffer.from('B'), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    });
    writeFileSync(compressed, encodedB);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readHistoryText(dataDir, id)).toBe('A');
      restoreHistory(dataDir, id);
      expect(existsSync(compressed)).toBe(false);
      expect(readFileSync(plain, 'utf8')).toBe('A');
      expect(readFileSync(`${compressed}.orphaned`).equals(encodedB)).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain(`${compressed}.orphaned`);
      const calls = warn.mock.calls.length;
      restoreHistory(dataDir, id);
      expect(warn).toHaveBeenCalledTimes(calls);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips when eligibility flips mid-job', async () => {
    const { dataDir, id, plain, compressed } = setup();
    const original = transcript();
    writeFileSync(plain, original);
    let ok = true;
    const pending = compressHistory(dataDir, id, () => ok);
    ok = false;
    expect(await pending).toBe('skipped');
    expect(readFileSync(plain, 'utf8')).toBe(original);
    expect(existsSync(compressed)).toBe(false);
    expect(leftoverTmp(dataDir)).toEqual([]);
  });

  it('returns changed when the plain file grows mid-job', async () => {
    const { dataDir, id, plain, compressed } = setup();
    const original = transcript();
    writeFileSync(plain, original);
    const extra = '{"seq":2001,"type":"note"}\n';
    expect(await compressHistory(dataDir, id, () => {
      appendFileSync(plain, extra);
      return true;
    })).toBe('changed');
    expect(readFileSync(plain, 'utf8')).toBe(`${original}${extra}`);
    expect(existsSync(compressed)).toBe(false);
    expect(readdirSync(join(dataDir, 'runs')).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('source reads identically for both forms', async () => {
    const a = setup();
    const b = setup();
    const original = transcript();
    writeFileSync(a.plain, original);
    writeFileSync(b.plain, original);
    expect(await compressHistory(b.dataDir, b.id, () => true)).toBe('compressed');
    const plainSource = await openHistorySource(a.dataDir, a.id);
    const compressedSource = await openHistorySource(b.dataDir, b.id);
    expect(plainSource).toBeDefined();
    expect(compressedSource).toBeDefined();
    try {
      const size = Buffer.byteLength(original);
      expect(plainSource!.size).toBe(compressedSource!.size);
      expect(plainSource!.size).toBe(size);
      expect(await plainSource!.read(100, 500)).toEqual(await compressedSource!.read(100, 500));
      const plainTail = await plainSource!.read(size - 10, 50);
      const compressedTail = await compressedSource!.read(size - 10, 50);
      expect(plainTail).toHaveLength(10);
      expect(compressedTail).toEqual(plainTail);
      expect(await plainSource!.read(size, 10)).toHaveLength(0);
      expect(await compressedSource!.read(size, 10)).toHaveLength(0);
      expect(await plainSource!.read(size + 5, 10)).toHaveLength(0);
      expect(await compressedSource!.read(size + 5, 10)).toHaveLength(0);
      expect((await collect(plainSource!.stream(1234))).equals(await collect(compressedSource!.stream(1234)))).toBe(true);
    } finally {
      await plainSource!.close();
      await compressedSource!.close();
    }
  });

  it('removeHistory removes both forms, orphaned files, and tmp leftovers of any name', () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'plain');
    writeFileSync(compressed, 'br');
    writeFileSync(`${plain}.tmp`, 'plain-tmp');
    writeFileSync(`${compressed}.tmp`, 'br-tmp');
    writeFileSync(`${compressed}.${process.pid}.abc123.tmp`, 'pid-tmp');
    writeFileSync(`${plain}.${process.pid}.def456.tmp`, 'plain-pid-tmp');
    writeFileSync(`${compressed}.corrupt`, 'br-corrupt');
    writeFileSync(`${compressed}.orphaned`, 'br-orphaned');
    writeFileSync(`${compressed}.orphaned.1`, 'br-orphaned-1');
    writeFileSync(`${compressed}.orphaned.2`, 'br-orphaned-2');
    removeHistory(dataDir, id);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(`${plain}.tmp`)).toBe(false);
    expect(existsSync(`${compressed}.tmp`)).toBe(false);
    expect(existsSync(`${compressed}.${process.pid}.abc123.tmp`)).toBe(false);
    expect(existsSync(`${plain}.${process.pid}.def456.tmp`)).toBe(false);
    expect(existsSync(`${compressed}.corrupt`)).toBe(false);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
    expect(existsSync(`${compressed}.orphaned.1`)).toBe(false);
    expect(existsSync(`${compressed}.orphaned.2`)).toBe(false);
  });

  it('readHistoryText and openHistorySource return undefined when neither form exists', async () => {
    const { dataDir, id } = setup();
    expect(readHistoryText(dataDir, id)).toBeUndefined();
    expect(await openHistorySource(dataDir, id)).toBeUndefined();
  });

  it('streams from an open plain source after the file is compressed away', async () => {
    const { dataDir, id, plain } = setup();
    const original = transcript();
    writeFileSync(plain, original);
    const source = await openHistorySource(dataDir, id);
    expect(source).toBeDefined();
    try {
      expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
      expect(existsSync(plain)).toBe(false);
      expect((await collect(source!.stream(0))).toString('utf8')).toBe(original);
    } finally {
      await source!.close();
    }
  });

  it.each([
    ['corrupt', Buffer.from([0xff, 0x00, 0x01, 0xaa])],
    ['0-byte', Buffer.alloc(0)],
  ] as const)('treats a %s compressed transcript as missing', async (_label, bytes) => {
    const { dataDir, id, compressed } = setup();
    writeFileSync(compressed, bytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readHistoryText(dataDir, id)).toBeUndefined();
      expect(await openHistorySource(dataDir, id)).toBeUndefined();
      expect(readFileSync(compressed).equals(bytes)).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain(compressed);
      const calls = warn.mock.calls.length;
      expect(readHistoryText(dataDir, id)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(calls);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['corrupt', Buffer.from([0xff, 0x00, 0x01, 0xaa])],
    ['0-byte', Buffer.alloc(0)],
  ] as const)('renames an undecodable %s .br so restore does not throw', (_label, bytes) => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(compressed, bytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => restoreHistory(dataDir, id)).not.toThrow();
      expect(existsSync(plain)).toBe(false);
      expect(existsSync(compressed)).toBe(false);
      expect(readFileSync(`${compressed}.corrupt`).equals(bytes)).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain(compressed);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps successive undecodable .br restores as unique .corrupt files', () => {
    const { dataDir, id, plain, compressed } = setup();
    const first = Buffer.from([0xff, 0x00, 0x01, 0xaa]);
    const second = Buffer.from([0xbb, 0xcc, 0xdd, 0xee]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(compressed, first);
      restoreHistory(dataDir, id);
      writeFileSync(compressed, second);
      restoreHistory(dataDir, id);
      expect(existsSync(plain)).toBe(false);
      expect(existsSync(compressed)).toBe(false);
      expect(readFileSync(`${compressed}.corrupt`).equals(first)).toBe(true);
      expect(readFileSync(`${compressed}.corrupt.1`).equals(second)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('writes a per-process tmp name during compress and never overwrites .br.orphaned', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'keep');
    const orphaned = `${compressed}.orphaned`;
    writeFileSync(orphaned, 'old-orphan');
    let sawPidTmp = false;
    expect(await compressHistory(dataDir, id, () => {
      sawPidTmp = readdirSync(join(dataDir, 'runs')).some(
        (name) => name.startsWith(`${id}.ndjson.br.${process.pid}.`) && name.endsWith('.tmp'),
      );
      return true;
    })).toBe('compressed');
    expect(sawPidTmp).toBe(true);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(compressed)).toBe(true);
    expect(readFileSync(orphaned, 'utf8')).toBe('old-orphan');
    expect(historyPaths(dataDir, id).orphaned).toBe(orphaned);
  });

  it('orphans a non-prefix .br instead of renaming over it', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'new');
    const encodedOld = br('old');
    writeFileSync(compressed, encodedOld);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
      expect(existsSync(plain)).toBe(false);
      expect(brotliDecompressSync(readFileSync(compressed)).toString()).toBe('new');
      expect(readFileSync(`${compressed}.orphaned`).equals(encodedOld)).toBe(true);
      expect(leftoverTmp(dataDir)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('uses a unique orphan suffix when .orphaned already exists', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'new');
    const encodedOld = br('old');
    writeFileSync(compressed, encodedOld);
    writeFileSync(`${compressed}.orphaned`, 'already');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
      expect(readFileSync(`${compressed}.orphaned`, 'utf8')).toBe('already');
      expect(readFileSync(`${compressed}.orphaned.1`).equals(encodedOld)).toBe(true);
      expect(brotliDecompressSync(readFileSync(compressed)).toString()).toBe('new');
      expect(existsSync(plain)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('overwrites a .br whose decoded bytes are a prefix of the plain file', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'ABCDEF');
    writeFileSync(compressed, br('ABC'));
    expect(await compressHistory(dataDir, id, () => true)).toBe('compressed');
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
    expect(brotliDecompressSync(readFileSync(compressed)).toString()).toBe('ABCDEF');
  });

  it('returns changed when an existing .br is replaced mid-job', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'new');
    writeFileSync(compressed, br('old'));
    const replacement = br('other');
    expect(await compressHistory(dataDir, id, () => {
      writeFileSync(compressed, replacement);
      return true;
    })).toBe('changed');
    expect(readFileSync(plain, 'utf8')).toBe('new');
    expect(readFileSync(compressed).equals(replacement)).toBe(true);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
    expect(leftoverTmp(dataDir)).toEqual([]);
  });

  it('returns changed when a same-size .br is rename-replaced with mtime restored', async () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'new');
    const originalBr = br('old');
    writeFileSync(compressed, originalBr);
    const stamp = Math.floor(Date.now() / 1000);
    utimesSync(compressed, stamp, stamp);
    const inoBefore = statSync(compressed).ino;
    const replacement = Buffer.alloc(originalBr.length, 0x7e);
    expect(await compressHistory(dataDir, id, () => {
      const swap = `${compressed}.swap`;
      writeFileSync(swap, replacement);
      utimesSync(swap, stamp, stamp);
      renameSync(swap, compressed);
      expect(statSync(compressed).ino).not.toBe(inoBefore);
      expect(statSync(compressed).size).toBe(originalBr.length);
      return true;
    })).toBe('changed');
    expect(readFileSync(plain, 'utf8')).toBe('new');
    expect(readFileSync(compressed).equals(replacement)).toBe(true);
    expect(existsSync(`${compressed}.orphaned`)).toBe(false);
    expect(leftoverTmp(dataDir)).toEqual([]);
  });

  it('restore uses a unique orphan suffix so a non-prefix .br is never left in place', () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'A');
    const encodedB = br('B');
    writeFileSync(compressed, encodedB);
    writeFileSync(`${compressed}.orphaned`, 'already');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      restoreHistory(dataDir, id);
      expect(existsSync(compressed)).toBe(false);
      expect(readFileSync(plain, 'utf8')).toBe('A');
      expect(readFileSync(`${compressed}.orphaned`, 'utf8')).toBe('already');
      expect(readFileSync(`${compressed}.orphaned.1`).equals(encodedB)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
