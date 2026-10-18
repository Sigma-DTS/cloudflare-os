// A minimal ZIP writer for the Office Open XML packages the gatekeeper creates: deflated entries
// (stored when deflating doesn't help), UTF-8 names, one disk, no Zip64. Every package it writes is
// far below the 4 GiB a classic archive can hold, and `zip.ts` reads exactly this subset back.

import { crc32 } from "./zip";

/** One file in the archive. */
export interface ZipWriteEntry {
  /** The part name, without a leading slash: `word/document.xml`. */
  readonly name: string;
  readonly data: Uint8Array | string;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
/** General-purpose flag bit 11: the entry's name is UTF-8. */
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;

/**
 * Writes the entries, in order, as one ZIP archive. `modifiedAt` stamps every entry (DOS time has
 * two-second resolution and no zone, so it is written in UTC).
 */
export async function writeZip(entries: readonly ZipWriteEntry[], modifiedAt = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modifiedAt);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const deflated = await deflateRaw(data);
    const method = deflated.byteLength < data.byteLength ? DEFLATED : STORED;
    const body = method === DEFLATED ? deflated : data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, data.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    locals.push(local, body);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, data.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength + body.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const deflater = new CompressionStream("deflate-raw");
  const writer = deflater.writable.getWriter();
  void writer.write(data).then(() => writer.close());
  return new Uint8Array(await new Response(deflater.readable).arrayBuffer());
}

function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
