import { generateFixtures, fixtureDir } from './generate-fixtures.mjs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default async function setup() {
  // Vite must see publicDir and its contents when it starts, including on the first ZIP extraction.
  // Regenerate each run; do not rely on fixtures left over from a previous test.
  await generateFixtures();
  await cp(fileURLToPath(new URL('../dist/standalone', import.meta.url)), path.join(fixtureDir, 'mp3-demo'), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await setup();
