import { cp } from 'node:fs/promises';
import path from 'node:path';
import { root, pkg, writeZip } from './distribution.mjs';
await writeZip(`browser-mp3-${pkg.version}`, async stage => {
  await cp(path.join(root, 'dist/standalone'), stage, { recursive: true });
  await cp(path.join(root, 'docs/MP3.md'), path.join(stage, 'README.md'));
  await cp(path.join(root, 'docs/SOURCES.md'), path.join(stage, 'SOURCES.md'));
  for (const file of ['COPYING', 'COPYING.LESSER']) {
    await cp(path.join(root, 'third_party/lamejs', file), path.join(stage, 'third_party/lamejs', file));
  }
});
