import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// Unique per build: shown in the debug log and appended to the script URL so
// TV browsers never pair a fresh index.html with a cached sendspin.js.
const buildId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'dist/sendspin.js',
  format: 'iife',
  target: ['es2017'],
  platform: 'browser',
  sourcemap: true,
  minify: false,
  define: {
    'process.env.NODE_ENV': '"production"',
    __BUILD_ID__: JSON.stringify(buildId)
  }
});

await cp('public', 'dist', { recursive: true });

const html = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', html.replace('src="sendspin.js"', `src="sendspin.js?v=${buildId}"`));

console.log(`Built dist/ (build ${buildId})`);
