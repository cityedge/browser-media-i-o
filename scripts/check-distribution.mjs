import assert from 'node:assert/strict';
import { access, readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, npm } from './distribution.mjs';

const roots = ['src', 'scripts', 'tests', 'apps', 'examples', 'docs', 'third_party'];
const ignored = new Set(['node_modules', 'dist', 'tmp', 'generated']);
const files = ['README.md', 'CHANGELOG.md', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'];
async function visit(dir) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = dir + '/' + entry.name;
    if (entry.isDirectory()) { if (!ignored.has(entry.name)) await visit(relative); }
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Unexpected symlink in public source: ' + relative);
  }
}
for (const dir of roots) await visit(dir);
for (const obsolete of ['docs/LOCAL_HANDOFF.md', 'docs/IMPLEMENTATION_PLAN.md', 'examples/file-launch-probe',
  'docs/reports/file-launch/cloud-blocked.json', 'downloads', 'integrations']) {
  assert.equal(await lstat(path.join(root, obsolete)).then(() => true, () => false), false, 'Obsolete public content: ' + obsolete);
}
let links = 0;
for (const file of files.filter(f => f.endsWith('.md'))) {
  const text = await readFile(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(href.split('#')[0]));
    assert.ok(target.startsWith(root + path.sep), 'Nonportable link: ' + file + ' -> ' + href);
    await access(target).catch(() => { throw new Error('Broken link: ' + file + ' -> ' + href); });
    links++;
  }
}
const packed = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))[0];
const names = packed.files.map(file => file.path);
for (const name of names) {
  assert.ok(!/^(?:apps|tests|scripts|downloads|integrations|build|output)\//.test(name), 'Development content in npm package: ' + name);
  assert.ok(!/^(?:dist\/(?:browser|standalone)|docs\/reports)\//.test(name), 'Duplicate binary/report in npm package: ' + name);
  assert.ok(!/(?:AGENTS|LOCAL_HANDOFF|IMPLEMENTATION_PLAN)|\.(?:zip|tar\.gz)$/.test(name), 'Unnecessary npm content: ' + name);
}
for (const required of ['dist/index.js', 'dist/public.js', 'dist/aac.js', 'dist/mp3.js', 'dist/mp3-worker-source.js',
  'dist/index.d.ts', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(names.includes(required), 'Missing npm entry: ' + required);
await mkdir(path.join(root, 'output/validation'), { recursive: true });
await writeFile(path.join(root, 'output/validation/distribution.json'), JSON.stringify({ checkedLinks: links, npmFiles: names, npmBytes: packed.size }, null, 2) + '\n');
console.log(`Checked ${links} relative Markdown links; npm package: ${names.length} files, ${packed.size} bytes; public-content rules passed.`);
