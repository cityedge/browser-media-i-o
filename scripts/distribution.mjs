import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { archive } from './local-archive.mjs';

export const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
export const releases = path.join(root, 'output/releases');
export const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export function npm(args, options = {}) {
  if (!process.env.npm_execpath) throw new Error('Run this command through npm run.');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, ...options });
}
export async function copy(relative, stage, target = relative) {
  await cp(path.join(root, relative), path.join(stage, target), { recursive: true,
    filter: source => !/(?:^|[\\/])(?:node_modules|generated|tmp|dist)(?:[\\/]|$)/.test(path.relative(path.join(root, relative), source)),
  });
}
export async function writeZip(name, populate) {
  const build = path.join(root, 'build');
  await mkdir(build, { recursive: true });
  await mkdir(releases, { recursive: true });
  const stage = await mkdtemp(path.join(build, 'distribution-'));
  const pending = path.join(releases, `${name}.new.zip`);
  try {
    await populate(stage);
    const sums = [];
    async function visit(dir) {
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await visit(file);
        else if (item.isFile()) sums.push(`${await digest(file)}  ${path.relative(stage, file).replaceAll(path.sep, '/')}`);
        else throw new Error(`Unsupported archive entry: ${file}`);
      }
    }
    await visit(stage);
    await writeFile(path.join(stage, 'SHA256SUMS'), sums.join('\n') + '\n');
    await rm(pending, { force: true });
    archive('pack', stage, pending);
    const destination = path.join(releases, `${name}.zip`);
    await rename(pending, destination);
    await writeFile(path.join(releases, `${name}.sha256`), `${await digest(destination)}  ${name}.zip\n`);
    console.log(`${destination} (${sums.length} files)`);
  } finally {
    if (path.dirname(stage) !== build) throw new Error('Unexpected staging path');
    await rm(stage, { recursive: true, force: true });
  }
}
