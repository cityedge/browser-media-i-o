import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { root, pkg, copy, writeZip } from './distribution.mjs';
import { copyLocalSources } from './local-sources.mjs';
await writeZip(`browser-media-io-sources-${pkg.version}`, async stage => {
  for (const file of ['src', 'scripts', 'tests', 'apps/studio', 'examples', 'docs', 'third_party',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
    'playwright.config.ts', 'playwright.app.config.ts', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
    await copy(file, stage);
  }
  await mkdir(path.join(stage, 'third_party'), { recursive: true });
  await copyLocalSources(root, stage);
});
