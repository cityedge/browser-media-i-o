import { test, expect } from '@playwright/test';
import { cpus, platform, release } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyLongMedia } from '../../scripts/verify-long-media.mjs';
import type {} from './harness/main';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!window.mediaHarness); });
async function report(name: string, value: unknown) {
  if (!process.env.MEDIA_REPORT_DIR) return;
  await mkdir(process.env.MEDIA_REPORT_DIR, { recursive: true });
  await writeFile(path.join(process.env.MEDIA_REPORT_DIR, name), JSON.stringify(value, null, 2) + '\n');
}
function environment(browser: string) {
  return { browser, platform: platform(), osRelease: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, dateUTC: new Date().toISOString() };
}
function chromiumRss() {
  if (platform() !== 'linux') return null;
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).trim().split('\n').map(row => {
    const [pid, ppid, rss, ...command] = row.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(' ') };
  });
  const roots = rows.filter(row => /chromium/.test(row.command) && /--remote-debugging-pipe/.test(row.command) && !/--type=/.test(row.command));
  const ids = new Set(roots.map(row => row.pid));
  for (let i = 0; i < 8; i++) for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  return { processCount: ids.size, sumRssKiB: rows.filter(row => ids.has(row.pid)).reduce((n, row) => n + row.rss, 0),
    warning: 'Sum of process RSS includes shared pages more than once; not unique physical memory or a GPU allocation measurement.' };
}

const seconds = Number(process.env.RELEASE_MEDIA_SECONDS ?? 10);
test(`stream output ${seconds}s finalizes with head/middle/tail sync and bounded producer storage`, async ({ page, browser }, info) => {
  test.setTimeout(Math.max(90000, seconds * 1000));
  const resources: unknown[] = [], pending: Promise<void>[] = [];
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  page.on('console', message => {
    if (!message.text().startsWith('LONG_EXPORT ')) return;
    console.log(message.text());
    pending.push((async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      resources.push({ position: message.text(), metrics: metrics.filter(m => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(m.name)), rss: chromiumRss() });
    })());
  });
  const [download, result] = await Promise.all([page.waitForEvent('download', { timeout: seconds * 1000 + 90000 }),
    page.evaluate(s => window.mediaHarness.longExport(s), seconds)]);
  const output = info.outputPath('long-export.mp4'); await download.saveAs(output); await Promise.all(pending);
  expect(result.videoFrames).toBe(seconds * 30); expect(result.audioSamples).toBe(seconds * 48000);
  expect(result.peakWrites).toBe(1); expect(result.pcmBytes).toBe(12800); expect(result.heldCanvasCount).toBe(1);
  const verified = verifyLongMedia(output, seconds);
  const data = { environment: environment(browser.version()), result, resources, verified };
  await info.attach('long-export.json', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
  await report(`long-${seconds}s.json`, data);
});

if (process.env.RUN_MEDIA_BENCHMARK === '1') test('record two-input read and seek performance separately from WebGL/PCM export', async ({ page, browser }, info) => {
  const result = await page.evaluate(() => window.mediaHarness.measureReads());
  expect(result.decode.pairs).toBe(300); expect(result.seeks).toHaveLength(24);
  const data = { environment: environment(browser.version()), result };
  await info.attach('performance.json', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
  await report('performance.json', data);
});
