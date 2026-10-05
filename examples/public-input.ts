// Importing /public keeps the version-specific decoder adapter out of this module's graph.
import { openMedia, type MediaFrame } from 'browser-media-io/public';

/** The caller owns presentation/UI; each visited frame is borrowed until visit() returns. */
export async function visitFrames(file: Blob, times: Iterable<number>,
  visit: (time: number, frame: MediaFrame | null) => void | Promise<void>, signal?: AbortSignal) {
  const input = await openMedia(file);
  const reader = input.videoFramesAt(times, { signal });
  try {
    for await (const { time, frame } of reader) {
      try { await visit(time, frame); }
      finally { frame?.close(); }
    }
  } finally {
    try { await reader.return(); }
    finally { input.close(); }
  }
}
