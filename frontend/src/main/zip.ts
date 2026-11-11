/**
 * Minimal ZIP writer for the Electron main process.
 *
 * Node.js has no built-in ZIP packager, so we implement a small, standard
 * compliant writer (DEFLATE via the built-in `zlib` module + CRC-32).
 * This is only used to package log files when exporting diagnostics, and
 * keeps the app free of an extra npm dependency.
 */
import * as zlib from 'zlib';

// CRC-32 lookup table (IEEE 802.3 polynomial).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode a JS Date into DOS date/time fields used by the ZIP headers. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntry {
  name: string;
  data: string | Buffer;
}

/**
 * Create a valid .zip Buffer from the given entries.
 * Entries are DEFLATE-compressed and file names are stored as UTF-8.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const now = dosDateTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const dataBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf-8');
    const compressed = zlib.deflateRawSync(dataBuf, { level: 9 });
    const crc = crc32(dataBuf);

    // Local file header (30 bytes fixed + name + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature "PK\x03\x04"
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
    localHeader.writeUInt16LE(8, 8); // compression method: deflate
    localHeader.writeUInt16LE(now.time, 10);
    localHeader.writeUInt16LE(now.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localParts.push(localHeader, nameBuf, compressed);

    // Central directory file header (46 bytes fixed + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature "PK\x01\x02"
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 names
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(now.time, 12);
    centralHeader.writeUInt16LE(now.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature "PK\x05\x06"
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // entries this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
