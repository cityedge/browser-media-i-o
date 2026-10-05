// A separate offline file:// test. Never falls back to HTTP or relaxes browser access policy.
import { chromium } from '@playwright/test';
import { access, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const index = path.join(root, '.cache/file-launch-probe/index.html');
const fixture = path.join(root, 'tests/fixtures/generated/reference.mp4');
const output = path.join(root, 'test-results/file-launch-probe');
await mkdir(output, { recursive: true });
const report = { testedAt: new Date().toISOString(), status: 'failed', offline: true,
  target: 'file:// index.html', networkRequests: [], errors: [] };
let browser, timeout;
try {
  await access(index); await access(fixture);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (!existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ offline: true, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  context.on('request', request => { if (/^(https?|wss?):/.test(request.url())) report.networkRequests.push(request.url()); });
  const job = async () => {
    await page.goto(pathToFileURL(index).href);
    report.protocol = await page.evaluate(() => location.protocol);
    await page.waitForFunction(() => typeof window.verifyRelease === 'function');
    await page.setInputFiles('#source', fixture);
    report.input = await page.evaluate(() => window.readSelectedFile());
    report.output = await page.evaluate(() => window.verifyRelease());
    if (report.input.packets !== 300 || !Number.isFinite(report.input.timestamp)
      || Math.abs(report.input.timestamp - 5) > 0.000002)
      throw new Error('Input frame/probe result differs from the generated reference.');
    if (report.output.frames !== 30 || report.output.samples !== 48000 || !report.output.identicalStandaloneMp3)
      throw new Error('Output roundtrip differs from the expected result.');
    report.downloads = {};
    for (const format of ['mp4', 'mp3']) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click(`#save-${format}`)]);
      const destination = path.join(output, `local-output.${format}`);
      await download.saveAs(destination);
      if (await download.failure()) throw new Error(await download.failure());
      const bytes = (await stat(destination)).size;
      if (bytes === 0) throw new Error(`Empty ${format} download`);
      report.downloads[format] = { bytes };
    }
    if (report.networkRequests.length || report.errors.length) throw new Error('Network requests or page errors were observed.');
  };
  await Promise.race([job(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Probe timeout (90s)')), 90_000); })]);
  report.status = 'passed';
} catch (error) {
  report.failure = String(error);
  if (report.failure.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) report.status = 'blocked-by-browser-policy';
  process.exitCode = 1; // A blocked run is not a successful file:// validation.
} finally {
  clearTimeout(timeout);
  await browser?.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
