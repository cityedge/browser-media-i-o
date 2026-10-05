// Recreate the cloud's unpublished file:// probe without using anything from its .cache.
import { build } from 'esbuild';
import { mkdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.cache/file-launch-probe');
await access(path.join(root, 'dist/public.js')); // Run npm run build first.
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['examples/file-launch-probe/entry.js'],
  bundle: true, platform: 'browser', format: 'iife', minify: true, legalComments: 'inline',
  outfile: path.join(output, 'app.js'),
});
await copyFile(new URL('./index.html', import.meta.url), path.join(output, 'index.html'));
await copyFile(path.join(root, 'dist/standalone/browser-mp3.js'), path.join(output, 'standalone.js'));
console.log(`Built development probe: ${path.join(output, 'index.html')}`);
console.log('This verifies bundling only. file:// execution requires a separate browser test.');
