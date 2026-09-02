/**
 * serve.mjs — two modes:
 *
 *   node build/serve.mjs            dev server with hot rebuild (esbuild serve + watch)
 *   node build/serve.mjs --preview  static server for dist/ (what the built file will be)
 *
 * Dev mode serves build/dev.html as /, and compiles src/main.ts (ESM, sourcemaps)
 * and src/app.css into dev/ so the browser loads real modules — fast iteration,
 * same sources that get inlined into the single file at build time.
 */
import { context } from 'esbuild';
import { copyFile, mkdir, watch } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preview = process.argv.includes('--preview');

if (preview) {
  const dist = join(root, 'dist');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  const server = createServer(async (req, res) => {
    try {
      let p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (p === '/') p = '/index.html';
      const file = join(dist, p);
      if (!file.startsWith(dist)) throw new Error('forbidden');
      const info = await stat(file);
      res.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-length': info.size,
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  const port = 4174;
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Preview:  http://localhost:${port}/  (serving dist/)\n`);
  });
} else {
  const devDir = join(root, 'dev');
  await mkdir(devDir, { recursive: true });
  await copyFile(join(root, 'build/dev.html'), join(devDir, 'index.html'));

  const ctx = await context({
    entryPoints: [join(root, 'src/main.ts'), join(root, 'src/app.css')],
    outdir: devDir,
    entryNames: '[name]',
    bundle: true,
    format: 'esm',
    sourcemap: true,
    logLevel: 'info',
    target: ['es2022', 'chrome105', 'firefox110', 'safari16'],
  });

  const { port } = await ctx.serve({ servedir: devDir, port: 4173, host: '127.0.0.1' });
  // Always advertise the localhost hostname: an Origin of http://localhost:4173
  // satisfies the default CORS allow-lists of Ollama and most local servers.
  console.log(
    `\n  Page Turn dev server:  http://localhost:${port}/\n  (rebuilds on save; Ctrl-C to stop)\n`,
  );

  // Keep dev/index.html in sync if the template changes.
  for await (const change of watch(join(root, 'build/dev.html'))) {
    if (change.filename) await copyFile(join(root, 'build/dev.html'), join(devDir, 'index.html'));
  }
}
