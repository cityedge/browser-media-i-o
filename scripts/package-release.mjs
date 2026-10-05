// Build a portable source + binary release. Requires npm and Info-ZIP's zip command.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'browser-media-io' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('Unexpected package identity');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script with npm run package:release.');
const npm = (args, options = {}) => execFileSync(process.execPath, [npmCli, ...args], { cwd: root, ...options });
execFileSync('zip', ['-v'], { stdio: 'ignore' });
// Do not let deleted or renamed modules survive in the next release.
await rm(path.join(root, 'dist'), { recursive: true, force: true });
npm(['run', 'build'], { stdio: 'inherit' });

const name = `${pkg.name}-${pkg.version}`;
const destination = path.join(root, 'downloads/browser-media-io');
const temp = await mkdtemp(path.join(tmpdir(), 'browser-media-io-release-'));
const stage = path.join(temp, name);
const inputs = [
  'README.md', 'CHANGELOG.md', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md', '.gitignore',
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  'playwright.config.ts', 'playwright.app.config.ts',
  'src', 'dist', 'docs', 'examples', 'scripts', 'tests', 'apps/studio', 'third_party',
  // Template needed by the existing optional package:mp3 command, without its old ZIPs.
  'downloads/browser-mp3/README.md',
];
const ignored = new Set(['node_modules', '.git', '.cache', 'test-results', 'playwright-report']);
const included = [];
async function copy(relative) {
  const source = path.join(root, relative), target = path.join(stage, relative);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a release: ${relative}`);
  if (info.isDirectory()) {
    if (ignored.has(path.basename(relative)) || (path.basename(relative) === 'dist' && relative !== 'dist')
      || relative.replaceAll(path.sep, '/') === 'tests/fixtures/generated') return;
    await mkdir(target, { recursive: true });
    for (const entry of (await readdir(source)).sort()) await copy(path.join(relative, entry));
  } else if (info.isFile()) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target); included.push(relative.replaceAll(path.sep, '/'));
  } else throw new Error(`Unsupported release file: ${relative}`);
}
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
try {
  for (const input of inputs) await copy(input);
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { encoding: 'utf8' }));
  if (packed.length !== 1 || packed[0].filename !== `${name}.tgz`) throw new Error('Unexpected npm pack output');
  await mkdir(path.join(stage, 'packages'), { recursive: true });
  await cp(path.join(temp, `${name}.tgz`), path.join(stage, 'packages', `${name}.tgz`));
  included.push(`packages/${name}.tgz`);

  for (const relative of included.filter(file => file.endsWith('.md'))) {
    const text = await readFile(path.join(stage, relative), 'utf8');
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      const target = path.resolve(stage, path.dirname(relative), decodeURIComponent(href.split('#')[0]));
      if (!target.startsWith(stage + path.sep) || !(await stat(target).catch(() => null))) {
        throw new Error(`Broken or nonportable Markdown link: ${relative} -> ${href}`);
      }
    }
  }
  const checksums = [];
  for (const relative of included.sort()) checksums.push(`${await digest(path.join(stage, relative))}  ${relative}`);
  await writeFile(path.join(stage, 'SHA256SUMS'), checksums.join('\n') + '\n');
  included.push('SHA256SUMS');
  // Stable order/modes/times. No host-specific ZIP extras or parent directory entries.
  const epoch = new Date('2000-01-01T00:00:00Z');
  for (const relative of included) {
    const file = path.join(stage, relative);
    await chmod(file, 0o644); await utimes(file, epoch, epoch);
  }
  const zip = path.join(temp, `${name}.zip`);
  execFileSync('zip', ['-q', '-X', '-9', zip, '-@'], {
    cwd: temp, env: { ...process.env, TZ: 'UTC' },
    input: included.sort().map(file => `${name}/${file}`).join('\n') + '\n',
  });
  await writeFile(path.join(temp, 'SHA256SUMS'),
    `${await digest(zip)}  ${name}.zip\n${await digest(path.join(temp, `${name}.tgz`))}  ${name}.tgz\n`);
  await cp(path.join(temp, 'SHA256SUMS'), path.join(temp, `${name}.sha256`));
  await mkdir(destination, { recursive: true });
  // Only replace the completed outputs; a failed build/link check leaves the old release intact.
  for (const file of [`${name}.zip`, `${name}.tgz`, `${name}.sha256`, 'SHA256SUMS']) {
    const pending = path.join(destination, `${file}.new`);
    await cp(path.join(temp, file), pending);
    await rename(pending, path.join(destination, file));
  }
  console.log(`Release: ${path.relative(root, path.join(destination, `${name}.zip`))}`);
  console.log(`${included.length} files; ${(await stat(zip)).size} ZIP bytes; internal and external SHA-256 manifests generated.`);
} finally { await rm(temp, { recursive: true, force: true }); }
