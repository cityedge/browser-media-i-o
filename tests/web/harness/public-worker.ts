import { publicRoundtrip } from './public-roundtrip';

addEventListener('message', async (event: MessageEvent<Blob>) => {
  try { postMessage(await publicRoundtrip(event.data)); }
  catch (error) { postMessage({ error: String(error) }); }
});
