import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** Minimal ZIP (PKWARE APPNOTE 6.3) writer: deflate entries, UTF-8 names, no ZIP64 (batches are capped well below 4 GB). */
export function zipFiles(files: Array<{ name: string; data: Buffer; date?: Date }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const packed = deflateRawSync(f.data, { level: 6 });
    const useDeflate = packed.length < f.data.length;
    const body = useDeflate ? packed : f.data;
    const d = f.date ?? new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * The timestamp to give every entry of a ZIP that must come out byte-identical whenever and wherever it is built:
 * the earliest date the format can hold (1 January 1980, 00:00), read through local-time getters as the writer does,
 * so the stored value does not depend on the machine's time zone.
 */
export const ZIP_FIXED_DATE = new Date(1980, 0, 1, 0, 0, 0);

export interface ZipEntry { name: string; size: number; compressedSize: number; method: number; crc: number; offset: number }

/** The entries of a ZIP written by `zipFiles` (or any plain, single-disk, non-ZIP64 archive), in stored order. */
export function zipEntries(zip: Buffer): ZipEntry[] {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a ZIP archive.');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
    const nameLen = zip.readUInt16LE(at + 28), extraLen = zip.readUInt16LE(at + 30), commentLen = zip.readUInt16LE(at + 32);
    out.push({ name: zip.toString('utf8', at + 46, at + 46 + nameLen), method: zip.readUInt16LE(at + 10), crc: zip.readUInt32LE(at + 16), compressedSize: zip.readUInt32LE(at + 20), size: zip.readUInt32LE(at + 24), offset: zip.readUInt32LE(at + 42) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The bytes of one entry, checked against its stored CRC. */
export function zipRead(zip: Buffer, entry: ZipEntry): Buffer {
  if (zip.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error(`The ZIP entry ${entry.name} is damaged.`);
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const body = zip.subarray(start, start + entry.compressedSize);
  const data = entry.method === 8 ? inflateRawSync(body) : Buffer.from(body);
  if ((crc32(data) >>> 0) !== entry.crc) throw new Error(`The ZIP entry ${entry.name} does not match its checksum.`);
  return data;
}
