import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Rebuild the JavaScript encoder from its pinned corresponding source. No compiler,
// WASM, network, or package mutation is needed. All generated files stay under build/.
export async function prepareLamejs() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const archive = path.join(root, 'third_party/lamejs/source.tar.gz');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (digest !== '9db4f8798baf8f667a5aea687bad4b30cae0663e69064675ec7f9882074eb55d') {
    throw new Error('Unexpected lamejs source archive; review the encoder patches before changing its version.');
  }
  const stage = path.join(root, 'build/mp3-encoder');
  await mkdir(stage, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', stage, 'lamejs/src/js'], { stdio: 'pipe' });
  await writeFile(path.join(stage, 'package.json'), '{"type":"commonjs"}\n');
  const source = path.join(stage, 'lamejs/src/js');
  for (const name of ['VBROldIterationLoop.js', 'ABRIterationLoop.js']) {
    await cp(path.join(root, 'third_party/lamejs/extensions', name), path.join(source, name));
  }
  async function patch(name, transform) {
    const file = path.join(source, name);
    await writeFile(file, transform(await readFile(file, 'utf8')));
  }
  function replace(text, from, to) {
    if (!text.includes(from)) throw new Error(`Missing lamejs patch anchor: ${from}`);
    return text.replaceAll(from, to);
  }
  await patch('Lame.js', s => `var VBROldIterationLoop = require('./VBROldIterationLoop.js');
var ABRIterationLoop = require('./ABRIterationLoop.js');
function linear_int(a, b, m) { return a + (b - a) * m; }
` + s);
  await patch('index.js', s => {
    s = replace(s, 'function Mp3Encoder(channels, samplerate, kbps)', 'function Mp3Encoder(channels, samplerate, kbps, options)');
    s = replace(s, 'arguments.length != 3', 'arguments.length < 3');
    s = replace(s, 'gfp.brate = kbps;', `gfp.brate = kbps;
    if (options && options.mode !== 'cbr') gfp.out_samplerate = samplerate;
    if (options && options.mode === 'vbr') {
        gfp.VBR = VbrMode.vbr_rh;
        gfp.VBR_q = options.vbrQuality;
    }
    if (options && options.mode === 'abr') {
        gfp.VBR = VbrMode.vbr_abr;
        gfp.VBR_mean_bitrate_kbps = kbps;
    }`);
    s = replace(s, 'assert(0 == retcode);', "if (retcode !== 0) throw new Error('MP3 encoder initialization failed: ' + retcode);");
    return replace(s, 'return new Int8Array(mp3buf.subarray(0, _sz));', "if (_sz < 0) throw new Error('MP3 encoding failed: ' + _sz);\n        return new Int8Array(mp3buf.subarray(0, _sz));");
  });
  // The unused VBR paths contain untranslated Java instance calls and integer
  // conversions. Keep these fixes explicit, reproducible, and outside node_modules.
  await patch('QuantizePVT.js', s => replace(s, '= athAdjust(', '= this.athAdjust('));
  await patch('Quantize.js', s => {
    s = `var MeanBits = require('./MeanBits.js');
var LameInternalFlags = require('./LameInternalFlags.js');
` + s;
    for (const call of ['get_framebits(gfp, frameBits)', 'init_outer_loop(gfc, cod_info)',
      'outer_loop(gfp, cod_info, l3_xmin, xrpow, ch, this_bits)', 'ms_convert(gfc.l3_side, gr)']) {
      s = replace(s, call + ';', 'this.' + call + ';');
    }
    s = replace(s, '(int)(', 'Math.trunc(');
    return replace(s, '(max_bits + min_bits) / 2', 'Math.trunc((max_bits + min_bits) / 2)');
  });
  return path.join(source, 'index.js');
}
