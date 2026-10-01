// Developer packaging command. Requires the `zip` utility; app users need neither Node nor zip.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const destination = path.resolve('downloads/browser-mp3', `browser-mp3-${version}.zip`);
const stage = await mkdtemp(path.join(tmpdir(), 'browser-mp3-package-'));
try {
  await cp('dist/standalone', stage, { recursive: true });
  await cp('third_party', path.join(stage, 'third_party'), { recursive: true });
  await cp('downloads/browser-mp3/README.md', path.join(stage, 'README.md'));
  // Include preferred wrapper/build sources so the encoder can be changed and relinked.
  const sourceFiles = ['src', 'scripts/build-mp3.mjs', 'package.json', 'package-lock.json',
    'tsconfig.json', 'tsconfig.build.json', 'examples', 'docs/MP3.md', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'];
  for (const file of sourceFiles) {
    const target = path.join(stage, 'source', file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target, { recursive: true });
  }
  await writeFile(path.join(stage, 'source/BUILD.md'), `# Rebuild Browser MP3\n\nRequires Node.js >=22.12.\nFrom this source directory:\n\n\x60\x60\x60sh\nnpm ci\nnpm run build\n\x60\x60\x60\n\nThe resulting dist/standalone/browser-mp3.js replaces the distributed file.\nTo change the encoder, extract ../third_party/lamejs/source.tar.gz, edit and\nbuild it using its package.json/pnpm-lock.yaml, then install that local package\nin this source directory and rerun npm run build. No signing key is needed.\nThe encoder has not been modified; it retains its LGPL-3.0 license.\nThe original wrapper and build scripts are MIT licensed.\n\nThis source snapshot includes the build inputs. Full tests and application sources:\nhttps://github.com/cityedge/codex_work_01\n`);
  await mkdir(path.dirname(destination), { recursive: true });
  // Remove a previous archive so obsolete entries cannot survive zip's update mode.
  await rm(destination, { force: true });
  execFileSync('zip', ['-q', '-r', destination, '.'], { cwd: stage });
  console.log(destination);
} finally {
  await rm(stage, { recursive: true, force: true });
}
