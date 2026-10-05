import { cp } from 'node:fs/promises';
import path from 'node:path';
import { root, pkg, writeZip } from './distribution.mjs';
await writeZip(`browser-media-io-browser-${pkg.version}`, async stage => {
  await cp(path.join(root, 'dist/browser'), stage, { recursive: true });
});
