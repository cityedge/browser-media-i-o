import { generateFixtures, fixtureDir } from '../../scripts/generate-fixtures.mjs';
import { cp } from 'node:fs/promises';
import path from 'node:path';

export default async function setup() {
  // Regenerate every run; a previous run's result must never count as fresh evidence.
  await generateFixtures();
  await cp('dist/standalone', path.join(fixtureDir, 'mp3-demo'), { recursive: true });
}
