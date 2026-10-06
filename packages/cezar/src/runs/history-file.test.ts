import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compressHistory,
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
    expect(existsSync(`${compressed}.tmp`)).toBe(false);
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
    expect(existsSync(`${plain}.tmp`)).toBe(false);
  });

  it('plain wins when both exist', () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'A');
    writeFileSync(
      compressed,
      brotliCompressSync(Buffer.from('B'), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }),
    );
    expect(readHistoryText(dataDir, id)).toBe('A');
    restoreHistory(dataDir, id);
    expect(existsSync(compressed)).toBe(false);
    expect(readFileSync(plain, 'utf8')).toBe('A');
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
    expect(existsSync(`${compressed}.tmp`)).toBe(false);
  });

  it('skips when the plain file grows mid-job', async () => {
    const { dataDir, id, plain, compressed } = setup();
    const original = transcript();
    writeFileSync(plain, original);
    const pending = compressHistory(dataDir, id, () => true);
    appendFileSync(plain, '{"seq":2001,"type":"note"}\n');
    expect(await pending).toBe('skipped');
    expect(readFileSync(plain, 'utf8')).toBe(`${original}{"seq":2001,"type":"note"}\n`);
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(`${compressed}.tmp`)).toBe(false);
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

  it('removeHistory removes both forms and tmp leftovers', () => {
    const { dataDir, id, plain, compressed } = setup();
    writeFileSync(plain, 'plain');
    writeFileSync(compressed, 'br');
    writeFileSync(`${plain}.tmp`, 'plain-tmp');
    writeFileSync(`${compressed}.tmp`, 'br-tmp');
    writeFileSync(`${compressed}.corrupt`, 'br-corrupt');
    removeHistory(dataDir, id);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(`${plain}.tmp`)).toBe(false);
    expect(existsSync(`${compressed}.tmp`)).toBe(false);
    expect(existsSync(`${compressed}.corrupt`)).toBe(false);
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
});
