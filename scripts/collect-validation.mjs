import { readFile, writeFile, mkdir } from 'node:fs/promises';
const directory = process.env.MEDIA_REPORT_DIR ?? 'docs/reports/v0.2';
await mkdir(directory, { recursive: true });
const cases = [], attachments = [];
for (const [group, file] of [['web', 'test-results/results.json'], ['app', 'test-results/app/results.json']]) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  function visit(suites) {
    for (const suite of suites) {
      visit(suite.suites ?? []);
      for (const spec of suite.specs ?? []) for (const test of spec.tests) {
        cases.push({ group, file: spec.file, title: spec.title, status: test.status,
          runs: test.results.map(r => ({ status: r.status, durationMs: r.duration, retry: r.retry })) });
        for (const result of test.results) for (const item of result.attachments ?? []) {
          if (!['capabilities.json', 'gray-values.json', 'gpu-result.json'].includes(item.name) || !item.body) continue;
          const data = JSON.parse(Buffer.from(item.body, 'base64').toString());
          if (data.verified) delete data.verified.ffprobe;
          attachments.push({ title: spec.title, name: item.name, data });
        }
      }
    }
  }
  visit(report.suites);
  await writeFile(`${directory}/${group}-stats.json`, JSON.stringify(report.stats, null, 2) + '\n');
}
await writeFile(`${directory}/regression.json`, JSON.stringify({ cases, attachments }, null, 2) + '\n');
