import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Build-time source materials only. Never called by the distributed browser application.
export async function copyLocalSources(root, stage) {
  const assets = [
    ['mediabunny-1.61.0.tar.gz', 'https://codeload.github.com/Vanilagy/mediabunny/tar.gz/refs/tags/v1.61.0', 'e9f099cab5f8206cd9ef82ade2d8ed42008fc7acaeca4f848e1b783cb9f29b98'],
    ['FFmpeg-COPYING.LGPLv2.1', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.0/COPYING.LGPLv2.1', '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30'],
  ];
  const cache = path.join(root, 'output/third-party');
  await mkdir(cache, { recursive: true });
  for (const [name, url, expected] of assets) {
    let bytes = await readFile(path.join(cache, name)).catch(() => undefined);
    // A source ZIP already includes the corresponding upstream materials.
    bytes ??= await readFile(path.join(root, 'third_party', name)).catch(() => undefined);
    if (!bytes) {
      console.log(`Downloading build-time source material: ${name}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Source download failed: ${url} (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`Source checksum mismatch: ${name}`);
    await writeFile(path.join(cache, name), bytes);
    await cp(path.join(cache, name), path.join(stage, 'third_party', name));
  }
  await writeFile(path.join(stage, 'third_party/SOURCES.json'), JSON.stringify(assets.map(([file, url, sha256]) => ({ file, url, sha256 })), null, 2) + '\n');
}
