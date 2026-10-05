import { execFileSync } from 'node:child_process';

// Paths travel as environment data, never as interpolated shell source.
export function archive(operation, source, destination) {
  if (process.platform === 'win32') {
    const command = operation === 'pack'
      ? 'Compress-Archive -Path (Join-Path $env:MEDIA_ARCHIVE_SOURCE "*") -DestinationPath $env:MEDIA_ARCHIVE_DESTINATION -CompressionLevel Optimal -Force'
      : 'Expand-Archive -LiteralPath $env:MEDIA_ARCHIVE_SOURCE -DestinationPath $env:MEDIA_ARCHIVE_DESTINATION -Force';
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: 'inherit', env: { ...process.env, MEDIA_ARCHIVE_SOURCE: source, MEDIA_ARCHIVE_DESTINATION: destination },
    });
  } else if (operation === 'pack') {
    execFileSync('zip', ['-q', '-r', destination, '.'], { cwd: source, stdio: 'inherit' });
  } else execFileSync('unzip', ['-q', source, '-d', destination], { stdio: 'inherit' });
}
