'use strict';

// Reads the failed-file list a merge-queue shard uploads (ci.yml, `failed-test-files-*-shard-N`)
// as untrusted bytes: queued code ran on that runner and can upload any archive under that name.
// Nothing here writes to disk or runs what it reads. See docs/sdlc/ci.md § Flake reports from
// the merge queue.
const zlib = require('node:zlib');

const LIST_FILE = 'failed-test-files.txt';
const MAX_ARCHIVE_BYTES = 64 * 1024;
const MAX_LIST_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 300;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
// `.e2e.ts` is the cockpit browser suite's suffix (packages/web/e2e/vitest.config.ts).
const TEST_SUFFIX = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const END_RECORD = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;

const malformed = (message) => Object.assign(new Error(message), { code: 'malformed' });

// A name the report may quote: safe characters only, no `.` or `..` segment, a test suffix.
function isTestPath(name) {
  return typeof name === 'string' && name.length <= MAX_PATH_LENGTH && TEST_SUFFIX.test(name)
    && name.split('/').every((segment) => SEGMENT.test(segment));
}

// The end record is 22 bytes plus a comment of at most 65,535 bytes.
function endRecord(buffer) {
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === END_RECORD) return at;
  }
  throw malformed('No zip end record');
}

function onlyEntry(buffer) {
  const end = endRecord(buffer);
  if (buffer.readUInt16LE(end + 10) !== 1) throw malformed('The archive must hold exactly one file');
  const at = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt32LE(at) !== CENTRAL_ENTRY) throw malformed('No central directory entry');
  const nameLength = buffer.readUInt16LE(at + 28);
  return {
    centralAt: at,
    flags: buffer.readUInt16LE(at + 8),
    method: buffer.readUInt16LE(at + 10),
    crc: buffer.readUInt32LE(at + 16),
    packed: buffer.readUInt32LE(at + 20),
    size: buffer.readUInt32LE(at + 24),
    name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
    localAt: buffer.readUInt32LE(at + 42),
  };
}

// The local header's sizes are zero when a data descriptor follows, so the central entry's count.
function entryData(buffer, entry) {
  if (buffer.readUInt32LE(entry.localAt) !== LOCAL_ENTRY) throw malformed('No local entry');
  const start = entry.localAt + 30 + buffer.readUInt16LE(entry.localAt + 26) + buffer.readUInt16LE(entry.localAt + 28);
  if (start + entry.packed > entry.centralAt) throw malformed('Entry data overruns the archive');
  const data = buffer.subarray(start, start + entry.packed);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_LIST_BYTES });
  throw malformed('Unsupported compression');
}

function parseArchive(buffer) {
  const entry = onlyEntry(buffer);
  if (entry.name !== LIST_FILE) throw malformed('Unexpected file in the archive');
  if (entry.flags & 1) throw malformed('Encrypted entry');
  if (entry.size > MAX_LIST_BYTES) throw malformed('List above its limit');
  const bytes = entryData(buffer, entry);
  if (bytes.length !== entry.size || zlib.crc32(bytes) !== entry.crc) throw malformed('Entry size or CRC differs');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// Returns the list's text, or throws an error whose code is `malformed`.
function readList(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) throw malformed('Archive empty or above its limit');
  try {
    return parseArchive(buffer);
  } catch (error) {
    if (error.code === 'malformed') throw error;
    throw malformed('Unreadable archive');
  }
}

// One repository-relative path per line, as .github/scripts/vitest-rerun-reset.cjs writes them.
function parseNames(text) {
  const names = new Set();
  let dropped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;
    if (isTestPath(line)) names.add(line);
    else dropped++;
  }
  return { names: [...names].sort(), dropped };
}

module.exports = { readList, parseNames, isTestPath, LIST_FILE, MAX_ARCHIVE_BYTES, MAX_LIST_BYTES };
