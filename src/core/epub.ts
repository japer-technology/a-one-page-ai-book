/**
 * core/epub.ts — compile a book into a real EPUB 3 file, dependency-free.
 *
 * EPUB is a ZIP with a mandated layout; we write a minimal STORE-only ZIP
 * (no compression — prose compresses trivially and local files stay small),
 * CRC-32 checked, UTF-8 flags set. Pure functions returning bytes, so the
 * whole thing is unit-testable without a browser.
 */
import type { CompiledBook } from './compile';

// ---- CRC-32 (the ZIP polynomial) -------------------------------------------

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

// ---- Minimal STORE-only ZIP writer -----------------------------------------

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

class ZipWriter {
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
      view.setUint32(0, 0x04034b50, true); // local file header
      view.setUint16(4, 20, true); // version needed
      view.setUint16(6, 0x0800, true); // UTF-8 names
      view.setUint16(8, 0, true); // method: stored
      view.setUint32(14, crc, true);
      view.setUint32(18, entry.data.length, true); // compressed
      view.setUint32(22, entry.data.length, true); // uncompressed
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true); // extra len
      parts.push(header, nameBytes, entry.data);

      const record = new Uint8Array(46);
      const rec = new DataView(record.buffer);
      rec.setUint32(0, 0x02014b50, true); // central directory
      rec.setUint16(4, 20, true); // version made by
      rec.setUint16(6, 20, true); // version needed
      rec.setUint16(8, 0x0800, true);
      rec.setUint16(10, 0, true);
      rec.setUint32(16, crc, true);
      rec.setUint32(20, entry.data.length, true);
      rec.setUint32(24, entry.data.length, true);
      rec.setUint16(28, nameBytes.length, true);
      rec.setUint32(42, offset, true); // local header offset
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

// ---- EPUB assembly ----------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function epubBytes(compiled: CompiledBook): Uint8Array {
  const zip = new ZipWriter();
  // The mimetype entry MUST be first and stored uncompressed.
  zip.add('mimetype', 'application/epub+zip');
  zip.add('META-INF/container.xml', containerXml());
  zip.add('OEBPS/content.opf', contentOpf(compiled));
  zip.add('OEBPS/nav.xhtml', navXhtml(compiled));
  zip.add('OEBPS/style.css', epubCss());
  zip.add('OEBPS/title.xhtml', titleXhtml(compiled));
  compiled.pages.forEach((page) => {
    zip.add(`OEBPS/p${page.number}.xhtml`, chapterXhtml(compiled, page.number, page.text));
  });
  if (compiled.cast) zip.add('OEBPS/cast.xhtml', castXhtml(compiled));
  return zip.finish();
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function contentOpf(compiled: CompiledBook): string {
  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
  ];
  const spine: string[] = ['<itemref idref="title"/>'];
  compiled.pages.forEach((page) => {
    manifest.push(
      `<item id="p${page.number}" href="p${page.number}.xhtml" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="p${page.number}"/>`);
  });
  if (compiled.cast) {
    manifest.push('<item id="cast" href="cast.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cast"/>');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">page-turn-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(compiled.title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Directed page by page in Page Turn</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString()}</meta>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    ${spine.join('\n    ')}
  </spine>
</package>`;
}

function navXhtml(compiled: CompiledBook): string {
  const items = compiled.pages
    .map((page) => `<li><a href="p${page.number}.xhtml">Page ${page.number}</a></li>`)
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="title.xhtml">Title page</a></li>
      ${items}
      ${compiled.cast ? '<li><a href="cast.xhtml">The cast</a></li>' : ''}
    </ol>
  </nav>
</body>
</html>`;
}

function epubCss(): string {
  return `body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.7; margin: 5%; max-width: 36em; }
h1 { text-align: center; margin-top: 25%; }
p { margin: 0 0 1em 0; text-indent: 1.5em; }
p.noindent { text-indent: 0; }
.cast h2 { margin-top: 2em; }
.mood { color: #555; font-size: 0.85em; text-indent: 0; }`;
}

function titleXhtml(compiled: CompiledBook): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(compiled.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <h1>${escapeXml(compiled.title)}</h1>
  <p class="noindent">A book directed page by page in Page Turn.</p>
  ${compiled.seed ? `<p class="noindent">Seed: ${escapeXml(compiled.seed)}</p>` : ''}
  <p class="mood">${moodLine(compiled)}</p>
</body>
</html>`;
}

function chapterXhtml(compiled: CompiledBook, number: number, text: string): string {
  const mood = compiled.pages[number - 1]?.mood;
  const paragraphs = text
    .split(/\n[ \t]*\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `<p>${escapeXml(part)}</p>`)
    .join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Page ${number}</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <p class="mood noindent">Page ${number}${mood ? ` · ${mood.icon} ${mood.label} ${mood.value > 0 ? '+' : ''}${mood.value}` : ''}</p>
  ${paragraphs}
</body>
</html>`;
}

function castXhtml(compiled: CompiledBook): string {
  const group = (
    label: string,
    entries: Array<{ name: string; note: string; details?: string }>,
  ) =>
    entries.length === 0
      ? ''
      : `<h2>${label}</h2>\n<ul>${entries
          .map(
            (entry) =>
              `<li><strong>${escapeXml(entry.name)}</strong>${entry.note ? ` — ${escapeXml(entry.note)}` : ''}${entry.details ? ` <em>(${escapeXml(entry.details)})</em>` : ''}</li>`,
          )
          .join('\n')}</ul>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>The cast</title><link rel="stylesheet" href="style.css"/></head>
<body class="cast">
  <h1>The cast</h1>
  ${group('People', compiled.cast?.people ?? [])}
  ${group('Places', compiled.cast?.places ?? [])}
  ${group('Things', compiled.cast?.things ?? [])}
  ${group('Open threads', compiled.cast?.threads ?? [])}
</body>
</html>`;
}

/** One compact line of the per-page mood map for the title page. */
export function moodLine(compiled: CompiledBook): string {
  const marks = compiled.pages
    .map((page) =>
      page.mood
        ? `${page.number}${page.mood.icon}${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((mark): mark is string => mark !== null);
  return marks.length > 0 ? `Mood map: ${marks.join(' · ')}` : '';
}
