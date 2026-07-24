/**
 * Minimal zero-dependency ZIP reader.
 *
 * Node 22 ships `node:zlib` but no archive reader, and the Assemblée nationale
 * bulk exports are plain deflate ZIPs (no encryption, no zip64, < 4 GB, well
 * under 65 535 entries). That is a small enough surface to read directly and
 * saves pulling `unzipper`/`adm-zip` into the dependency tree.
 *
 * Entries are decompressed lazily, one at a time, so a 26 MB archive holding
 * 8 400+ files never materialises fully in memory.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Locate the End Of Central Directory record by scanning backwards. */
function findEocd(buf) {
  const start = Math.max(0, buf.length - (EOCD_MIN + MAX_COMMENT));
  for (let i = buf.length - EOCD_MIN; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record found');
}

/**
 * Read the central directory.
 * @returns {Array<{name: string, method: number, compressedSize: number,
 *                  size: number, localHeaderOffset: number}>}
 */
export function listZipEntries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported by this reader');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`corrupt central directory at entry ${i} (offset ${p})`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompress a single entry.
 *
 * Sizes are taken from the central directory rather than the local header:
 * when the streaming flag (bit 3) is set the local header carries zeroes and
 * the real sizes live in the central directory / data descriptor.
 */
export function readZipEntry(buf, entry) {
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Iterate every file entry (directories skipped), decompressing lazily.
 * @param {Buffer} buf
 * @param {(name: string) => boolean} [filter]
 * @yields {{name: string, read: () => Buffer}}
 */
export function* iterateZip(buf, filter) {
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    if (filter && !filter(entry.name)) continue;
    yield { name: entry.name, size: entry.size, read: () => readZipEntry(buf, entry) };
  }
}

/** Convenience: iterate entries already parsed as JSON. */
export function* iterateZipJson(buf, filter) {
  for (const entry of iterateZip(buf, filter)) {
    yield { name: entry.name, json: JSON.parse(entry.read().toString('utf8')) };
  }
}
