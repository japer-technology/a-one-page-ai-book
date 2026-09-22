/**
 * core/epub.ts — compile a book into a real EPUB 3 file, dependency-free.
 *
 * EPUB is a ZIP with a mandated layout; we write a minimal STORE-only ZIP
 * (no compression — prose compresses trivially and local files stay small),
 * CRC-32 checked, UTF-8 flags set. Pure functions returning bytes, so the
 * whole thing is unit-testable without a browser.
 */
import type { CompiledBook } from './compile';
import { ZipWriter } from './zip';
import type { PdfFontPrefs } from './pdf';

// ---- EPUB assembly ----------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function epubBytes(compiled: CompiledBook, fonts?: PdfFontPrefs): Uint8Array {
  const zip = new ZipWriter();
  // The mimetype entry MUST be first and stored uncompressed.
  zip.add('mimetype', 'application/epub+zip');
  zip.add('META-INF/container.xml', containerXml());
  zip.add('OEBPS/content.opf', contentOpf(compiled));
  zip.add('OEBPS/nav.xhtml', navXhtml(compiled));
  zip.add('OEBPS/style.css', epubCss(fonts));
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
    .map((page) =>
      page.kind === 'prologue'
        ? `<li><a href="p${page.number}.xhtml">Prologue</a></li>`
        : `<li><a href="p${page.number}.xhtml">Page ${page.number}</a></li>`,
    )
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

function epubCss(fonts?: PdfFontPrefs): string {
  // Honor the reader's font selection: sans stays sans, everything serif-y
  // stays a classic book serif (e-readers render their own embedded choice).
  const family =
    fonts?.readingFont === 'sans'
      ? "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
      : "Georgia, 'Times New Roman', serif";
  return `body { font-family: ${family}; line-height: 1.7; margin: 5%; max-width: 36em; }
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
  // Find the page by its NUMBER, not by array index: the prologue (page 0)
  // shifts every index by one and pages[] is ordered, not offset-aligned.
  const page = compiled.pages.find((p) => p.number === number);
  const isPrologue = page?.kind === 'prologue';
  const mood = page?.mood;
  const paragraphs = text
    .split(/\n[ \t]*\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `<p>${escapeXml(part)}</p>`)
    .join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${isPrologue ? 'Prologue' : `Page ${number}`}</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <p class="mood noindent">${isPrologue ? 'Prologue' : `Page ${number}`}${mood ? ` · ${mood.icon} ${mood.label} ${mood.value > 0 ? '+' : ''}${mood.value}` : ''}</p>
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
    .filter((page) => page.number > 0)
    .map((page) =>
      page.mood
        ? `${page.number}${page.mood.icon}${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((mark): mark is string => mark !== null);
  return marks.length > 0 ? `Mood map: ${marks.join(' · ')}` : '';
}
