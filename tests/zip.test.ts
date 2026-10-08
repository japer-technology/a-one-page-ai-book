import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../src/core/zip';

describe('the ZIP writer’s limits', () => {
  it('refuses more entries than the 16-bit EOCD can hold instead of silently wrapping', () => {
    // 70000 entries used to be written as “4464” in the EOCD (count mod
    // 65536) with no Zip64 records — a lying archive emitted in silence.
    const zip = new ZipWriter();
    for (let i = 0; i < 0x10000; i++) zip.add(`f${i}`, 'x');
    expect(() => zip.finish()).toThrow(/65535-entry limit/);
  });
});
