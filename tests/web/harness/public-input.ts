import * as api from 'browser-media-io/public';
import { publicRoundtrip } from './public-roundtrip';

const harness = {
  api,
  async roundtrip(worker: boolean) {
    const blob = await (await fetch('/reference.mp4')).blob();
    let result: Awaited<ReturnType<typeof publicRoundtrip>>;
    if (worker) {
      const instance = new Worker(new URL('./public-worker.ts', import.meta.url), { type: 'module' });
      try {
        result = await new Promise((resolve, reject) => {
          instance.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
          instance.onerror = event => reject(new Error(event.message));
          instance.postMessage(blob);
        });
      } finally { instance.terminate(); }
    } else result = await publicRoundtrip(blob);
    const url = URL.createObjectURL(result.result.blob!), link = document.createElement('a');
    link.href = url; link.download = 'public-roundtrip.mp4'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ...result, result: { ...result.result, blob: undefined } };
  },
};
declare global { interface Window { publicInputHarness: typeof harness } }
window.publicInputHarness = harness;
