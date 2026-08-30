import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

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
    'process.env.NODE_ENV': '"production"'
  }
});

await cp('public', 'dist', { recursive: true });
console.log('Built dist/ with UI, favicon, manifest and sendspin.js');
