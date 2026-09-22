/**
 * core/zip.ts — a minimal STORE-only ZIP writer (no compression; local files
 * stay small), shared by the EPUB builder and the markdown-library bundle.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export class ZipWriter {
  private entries: ZipEntry[] = [];

  add(name: string, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.entries.push({ name, data: bytes });
  }

  finish(): Uint8Array {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      const header = new Uint8Array(30);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true); // UTF-8 names
      view.setUint16(8, 0, true); // stored
      view.setUint32(14, crc, true);
      view.setUint32(18, entry.data.length, true);
      view.setUint32(22, entry.data.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      parts.push(header, nameBytes, entry.data);

      const record = new Uint8Array(46);
      const rec = new DataView(record.buffer);
      rec.setUint32(0, 0x02014b50, true);
      rec.setUint16(4, 20, true);
      rec.setUint16(6, 20, true);
      rec.setUint16(8, 0x0800, true);
      rec.setUint16(10, 0, true);
      rec.setUint32(16, crc, true);
      rec.setUint32(20, entry.data.length, true);
      rec.setUint32(24, entry.data.length, true);
      rec.setUint16(28, nameBytes.length, true);
      rec.setUint32(42, offset, true);
      central.push(record, nameBytes);
      offset += header.length + nameBytes.length + entry.data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    const total = parts.reduce((sum, part) => sum + part.length, 0) + centralSize + end.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of [...parts, ...central, end]) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }
}
