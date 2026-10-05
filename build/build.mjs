/**
 * build.mjs — merge the whole modular source tree into ONE self-contained HTML file.
 *
 * Pipeline:
 *   1. esbuild bundles src/main.ts   -> .build/main.js  (single IIFE, no imports left)
 *   2. esbuild bundles src/app.css   -> .build/app.css  (@imports inlined, minified)
 *   3. The two artifacts are inlined into build/template.html at the
 *      {{__CSS__}} / {{__JS__}} placeholders.
 *   4. dist/page-turn.html (and dist/index.html) is the result: zero external
 *      requests, runs straight from file:// or any static host.
 *
 * No runtime dependencies, no CDN fonts, no fetch() at boot — the file is the app.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, '.build');
const DIST = path.join(root, 'dist');
const PKG = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

function gitShortHash() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const start = performance.now();

// SOURCE_DATE_EPOCH makes repeat builds byte-identical (reproducible builds,
// artifact pinning); without it the timestamp records when this build ran.
const builtAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
// dist/ is NOT wiped up front: a failed build used to delete the committed
// artifacts before esbuild or one of the guards could fail, so the shipped
// single file vanished from the tree until the next successful build. Both
// outputs are written (overwritten) only after everything has succeeded.
await mkdir(DIST, { recursive: true });

const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  target: ['es2022', 'chrome105', 'firefox110', 'safari16'],
  entryNames: '[name]',
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'src/main.ts'), path.join(root, 'src/app.css')],
  outdir: OUT,
  format: 'iife',
  define: { __BUILD_TIME__: JSON.stringify(builtAt) },
});

let css = await readFile(path.join(OUT, 'app.css'), 'utf8');
let js = await readFile(path.join(OUT, 'main.js'), 'utf8');

// Build metadata, visible in-app and from the devtools console.
js += `\nwindow.__BUILD__={name:${JSON.stringify(PKG.name)},version:${JSON.stringify(PKG.version)},builtAt:${JSON.stringify(builtAt)},commit:${JSON.stringify(gitShortHash())}};\n`;

let html = await readFile(path.join(root, 'build/template.html'), 'utf8');
if (!html.includes('{{__CSS__}}') || !html.includes('{{__JS__}}')) {
  throw new Error('build/template.html must contain the {{__CSS__}} and {{__JS__}} placeholders');
}
html = html.replace('{{__CSS__}}', () => css).replace('{{__JS__}}', () => js);

// Safety: the injected script must not terminate the host <script> tag early,
// and must not enter the tokenizer's escaped states. esbuild escapes
// `</script>` and `</style`, but it emits `<!--` raw — and inside <script>,
// `<!--` followed by `<script` puts the tokenizer in a state where the real
// `</script>` no longer closes the element (the rest of the document is
// swallowed and the app renders blank).
const scriptCloses = (html.match(/<\/script/gi) ?? []).length;
if (scriptCloses !== 1) {
  throw new Error(
    `Inlined JS contains ${scriptCloses - 1} raw "</script" sequences — refusing to emit a corrupt file. ` +
      'Check esbuild escaping or the template.',
  );
}
for (const [label, re] of [
  ['<!--', /<!--/],
  ['</style', /<\/style/i],
]) {
  if (re.test(js) || re.test(css)) {
    throw new Error(
      `Inlined asset contains a raw "${label}" sequence — refusing to emit a file that would not parse. ` +
        'Escape it in the source that introduced it.',
    );
  }
}

const outName = 'page-turn.html';
await writeFile(path.join(DIST, outName), html, 'utf8');
await cp(path.join(DIST, outName), path.join(DIST, 'index.html'));

const kb = (b) => `${(b / 1024).toFixed(1)} kB`;
const elapsed = ((performance.now() - start) / 1000).toFixed(1);
console.log(
  `\n✔ dist/${outName}  (html ${kb(Buffer.byteLength(html))} = css ${kb(Buffer.byteLength(css))} + js ${kb(Buffer.byteLength(js))}) in ${elapsed}s`,
);
console.log('  Open it directly with file:// — no server, no network needed.\n');
