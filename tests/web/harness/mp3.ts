import { encodeMp3, wavToMp3 } from 'browser-media-io/mp3';

const mp3Harness = {
  encodeMp3, wavToMp3,
  save(blob: Blob, name = 'output.mp3') {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
declare global { interface Window { mp3Harness: typeof mp3Harness; mp3Workers: { active: number; started: number } } }
window.mp3Harness = mp3Harness;
