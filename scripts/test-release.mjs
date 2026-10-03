import { spawnSync } from 'node:child_process';

// Cross-platform entry point, including PowerShell/Windows without POSIX env assignment.
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/web/release.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, RELEASE_MEDIA_SECONDS: process.env.RELEASE_MEDIA_SECONDS ?? '1800',
    RUN_MEDIA_BENCHMARK: '1', MEDIA_REPORT_DIR: process.env.MEDIA_REPORT_DIR ?? 'docs/reports/v0.2' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
