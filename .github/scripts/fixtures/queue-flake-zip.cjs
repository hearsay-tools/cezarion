'use strict';

// Builds a zip laid out as the pinned actions/upload-artifact writes one: general-purpose flag
// bit 3, zero sizes in the local header, a signed data descriptor after the data, and the real
// sizes and CRC in the central directory. Options let a test break one field.
const zlib = require('node:zlib');

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const flags = 0x08 | (entry.flags ?? 0);
    const crc = entry.crc ?? zlib.crc32(data);
    const size = entry.size ?? data.length;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(0), u32(0), u32(0),
      u16(name.length), u16(0), name, body, u32(0x08074b50), u32(crc), u32(body.length), u32(size),
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(0x032d), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc),
      u32(body.length), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0o100644 << 16),
      u32(offset), name,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

module.exports = { zip };
