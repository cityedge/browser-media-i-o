// Prepare release assets locally; uploading/publishing is a separate operation.
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, pkg, releases, digest, npm } from './distribution.mjs';
npm(['run', 'build'], { stdio: 'inherit' });
npm(['run', 'check:distribution'], { stdio: 'inherit' });
for (const script of ['package-browser', 'package-mp3', 'package-sources']) {
  execFileSync(process.execPath, [`scripts/${script}.mjs`], { cwd: root, stdio: 'inherit' });
}
const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', releases], { encoding: 'utf8' }));
if (packed.length !== 1 || packed[0].filename !== `${pkg.name}-${pkg.version}.tgz`) throw new Error('Unexpected npm pack output');
const files = [`browser-media-io-browser-${pkg.version}.zip`, `browser-mp3-${pkg.version}.zip`,
  `browser-media-io-sources-${pkg.version}.zip`, packed[0].filename];
const sums = [];
for (const file of files) sums.push(`${await digest(path.join(releases, file))}  ${file}`);
await writeFile(path.join(releases, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log('Release assets are ready in output/releases/. Publish the matching source ZIP alongside the binaries.');
