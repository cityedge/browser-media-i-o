import { generateFixtures } from '../../scripts/generate-fixtures.mjs';

export default async function setup() {
  // Regenerate every run; a previous run's result must never count as fresh evidence.
  await generateFixtures();
}
