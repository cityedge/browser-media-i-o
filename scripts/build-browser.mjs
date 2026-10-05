import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/browser');
await mkdir(output, { recursive: true });
for (const [entry, filename, globalName] of [
  ['browser', 'browser-media-io', 'BrowserMediaIO'],
  ['browser-public', 'browser-media-io-public', 'BrowserMediaIOPublic'],
]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [`dist/${entry}.js`],
    outfile: path.join(output, `${filename}.js`), bundle: true, format: 'iife',
    globalName, platform: 'browser', target: 'es2022', minify: true,
    legalComments: 'inline', metafile: true,
    banner: { js: '/*! Browser Media I/O | MIT + MPL-2.0 + LGPL dependencies. See THIRD_PARTY_NOTICES.md and SOURCES.md. */' },
  });
  if (entry === 'browser-public' && Object.keys(result.metafile.inputs).some(p => /(^|\/)decoder-session\.js$/.test(p))) {
    throw new Error('Public bundle includes the private decoder adapter.');
  }
  if (Object.values(result.metafile.outputs).some(out => out.imports.length)) {
    throw new Error('Classic bundle must not load external modules.');
  }
  await mkdir(path.join(root, 'build/browser'), { recursive: true });
  await writeFile(path.join(root, `build/browser/${filename}.meta.json`), JSON.stringify(result.metafile, null, 2) + '\n');
}
const example = path.join(output, 'examples/local');
await mkdir(example, { recursive: true });
for (const file of ['app.js', 'style.css']) await cp(path.join(root, 'examples/local', file), path.join(example, file));
const html = (await readFile(path.join(root, 'examples/local/index.html'), 'utf8'))
  .replace('src="./browser-media-io.js"', 'src="../../browser-media-io.js"')
  .replace('href="./README.md"', 'href="../../README.md"')
  .replace('href="./THIRD_PARTY_NOTICES.md"', 'href="../../THIRD_PARTY_NOTICES.md"');
await writeFile(path.join(example, 'index.html'), html);
for (const file of ['LICENSE.md', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, file), path.join(output, file));
await cp(path.join(root, 'docs/LOCAL_DISTRIBUTION.md'), path.join(output, 'README.md'));
await cp(path.join(root, 'docs/SOURCES.md'), path.join(output, 'SOURCES.md'));
await mkdir(path.join(output, 'licenses'), { recursive: true });
for (const [source, target] of [
  ['node_modules/mediabunny/LICENSE', 'Mediabunny-MPL-2.0.txt'],
  ['node_modules/@mediabunny/aac-encoder/LICENSE', 'AAC-encoder-MPL-2.0.txt'],
  ['third_party/lamejs/COPYING', 'GPL-3.0.txt'],
  ['third_party/lamejs/COPYING.LESSER', 'LGPL-3.0.txt'],
  ['third_party/ffmpeg/COPYING.LGPLv2.1', 'FFmpeg-LGPL-2.1.txt'],
]) await cp(path.join(root, source), path.join(output, 'licenses', target));
console.log(`Classic-script library: ${output}`);
