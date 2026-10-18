import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const out = new URL('.evidence/specimen/', root);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('specimen/main.tsx', root))],
  outfile: fileURLToPath(new URL('main.js', out)),
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  minify: false,
});
await writeFile(new URL('index.html', out), await readFile(new URL('specimen/index.html', root)));
console.log(`Built local component specimen: ${fileURLToPath(new URL('index.html', out))}`);
