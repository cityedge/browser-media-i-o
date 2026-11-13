// Conservative AVC access-unit validation. No pixel decoding and no changes to the bitstream.
import { copyFail, copyProofFail } from './video-copy-errors.js';
import type { VideoCopyDiagnosticCode } from './video-copy-diagnostics.js';
const bad = (message: string): never => copyFail('GOP_STRUCTURE', message);
class Bits {
  byte = 1; bit = 0;
  constructor(readonly data: Uint8Array) {}
  read(n = 1): number {
    if (n > 32) bad('Invalid AVC bit count.');
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (!this.bit && this.byte >= 3 && this.data[this.byte] === 3 && this.data[this.byte - 1] === 0 && this.data[this.byte - 2] === 0) this.byte++;
      if (this.byte >= this.data.length) bad('Truncated AVC header.');
      value = value * 2 + ((this.data[this.byte] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.byte++; }
    }
    return value;
  }
  ue(): number { let n = 0; while (!this.read()) if (++n > 30) bad('Invalid Exp-Golomb code.'); return 2 ** n - 1 + this.read(n); }
  se(): number { const x = this.ue(); return x % 2 ? (x + 1) / 2 : -x / 2; }
}
type Sps = { frameBits: number; poc: number; pocBits: number; gapsAllowed: boolean };
type Pps = { sps: Sps; bottom: number; redundant: number };
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export class AvcCopyValidator {
  readonly lengthSize: number;
  pixelAspectRatio?: { num: number; den: number };
  private sps = new Map<number, Sps>();
  private pps = new Map<number, Pps>();
  private parameters: Uint8Array[] = [];
  private previousReferenceFrame: number | undefined;
  constructor(description: Uint8Array, private readonly warn?: (code: VideoCopyDiagnosticCode, message: string) => void) {
    if (description.length < 7 || description[0] !== 1) bad('An AVC configuration record is required.');
    this.lengthSize = (description[4] & 3) + 1;
    if (this.lengthSize === 3) bad('Invalid AVC NAL length size.');
    let at = 6;
    const parameter = () => {
      const length = description[at] * 256 + description[at + 1]; at += 2;
      if (!length || at + length > description.length) bad('Invalid AVC parameter set.');
      const nal = description.slice(at, at + length); at += length; this.parameters.push(nal); return nal;
    };
    const count = description[5] & 31;
    if (count !== 1) copyFail('CONFIGURATION_CHANGE', 'Exactly one SPS is supported.');
    for (let i = 0; i < count; i++) {
      const nal = parameter(); if ((nal[0] & 31) !== 7) bad('Invalid SPS.');
      const b = new Bits(nal), profile = b.read(8); b.read(8); b.read(8); const id = b.ue();
      if (![66, 77, 88, 100].includes(profile)) bad('Only 8-bit baseline/main/high AVC is supported.');
      if (profile === 100) {
        if (b.ue() !== 1 || b.ue() !== 0 || b.ue() !== 0) bad('Only 8-bit 4:2:0 AVC is supported.');
        b.read();
        if (b.read()) {
          for (let list = 0; list < 8; list++) if (b.read()) {
            let last = 8, next = 8;
            for (let j = 0; j < (list < 6 ? 16 : 64); j++) {
              if (next) next = (last + b.se() + 256) % 256;
              last = next || last;
            }
          }
        }
      }
      const frameBits = b.ue() + 4, poc = b.ue(); let pocBits = 0;
      if (frameBits > 16) bad('Invalid AVC frame number size.');
      if (poc === 0) { pocBits = b.ue() + 4; if (pocBits > 16) bad('Invalid AVC picture order size.'); }
      else if (poc !== 2) bad('Picture order count type 1 is not supported.');
      b.ue(); const gapsAllowed = !!b.read();
      b.ue(); b.ue(); if (!b.read()) bad('Interlaced AVC is not supported.');
      b.read(); // direct_8x8_inference_flag
      if (b.read()) { b.ue(); b.ue(); b.ue(); b.ue(); } // cropping
      if (b.read() && b.read()) { // VUI and aspect_ratio_info_present_flag
        const idc = b.read(8);
        const ratios = [[1,1],[12,11],[10,11],[16,11],[40,33],[24,11],[20,11],[32,11],[80,33],[18,11],[15,11],[64,33],[160,99],[4,3],[3,2],[2,1]];
        const ratio = idc === 255 ? [b.read(16), b.read(16)] : ratios[idc - 1];
        if (idc && (!ratio || !ratio[0] || !ratio[1])) bad('Unsupported AVC sample aspect ratio.');
        if (ratio) this.pixelAspectRatio = { num: ratio[0], den: ratio[1] };
      }
      this.sps.set(id, { frameBits, poc, pocBits, gapsAllowed });
    }
    const ppsCount = description[at++];
    if (ppsCount !== 1) copyFail('CONFIGURATION_CHANGE', 'Exactly one PPS is supported.');
    for (let i = 0; i < ppsCount; i++) {
      const nal = parameter(); if ((nal[0] & 31) !== 8) bad('Invalid PPS.');
      const b = new Bits(nal), id = b.ue(), sps = this.sps.get(b.ue());
      if (!sps) bad('PPS references an unknown SPS.');
      b.read(); const bottom = b.read();
      if (b.ue() !== 0) bad('Flexible macroblock ordering is not supported.');
      b.ue(); b.ue(); b.read(); b.read(2); b.se(); b.se(); b.se(); b.read(); b.read();
      this.pps.set(id, { sps: sps!, bottom, redundant: b.read() });
    }
  }
  private unverified(code: VideoCopyDiagnosticCode, message: string) {
    if (this.warn) this.warn(code, message); else copyProofFail(code, message);
  }
  inspect(data: Uint8Array): boolean {
    let at = 0, slices = 0, idr: boolean | undefined, picture = '', lastMb = -1;
    let referenceFrame: number | undefined;
    while (at < data.length) {
      if (at + this.lengthSize > data.length) bad('Truncated NAL length.');
      let size = 0; for (let j = 0; j < this.lengthSize; j++) size = size * 256 + data[at++];
      if (!size || at + size > data.length) bad('Invalid NAL size.');
      const nal = data.subarray(at, at + size); at += size;
      if (nal[0] & 128) bad('Forbidden AVC NAL bit.');
      const type = nal[0] & 31;
      if (type === 7 || type === 8) {
        if (!this.parameters.some(p => equal(p, nal))) copyFail('CONFIGURATION_CHANGE', 'In-band SPS/PPS changed.');
      } else if (type === 1 || type === 5) {
        const b = new Bits(nal), mb = b.ue(), slice = b.ue(), ppsId = b.ue(), pps = this.pps.get(ppsId);
        if (!pps || slice > 9 || ![0, 1, 2].includes(slice % 5)) bad('Unsupported slice or parameter set.');
        if ((!slices && mb !== 0) || mb <= lastMb) this.unverified('SLICE_LAYOUT_UNVERIFIED', 'Incomplete picture or arbitrary slice ordering.');
        lastMb = mb;
        const s = pps!.sps, frame = b.read(s.frameBits), isIdr = type === 5;
        // An SPS permission is not evidence of an actual gap. For this newly accepted
        // subset, check each picture against the previous reference picture (H.264 7.4.3).
        // MMCO-5 resets requiring deeper slice parsing remain conservatively unsupported.
        if (!slices && s.gapsAllowed && !isIdr && this.previousReferenceFrame !== undefined
          && frame !== this.previousReferenceFrame && frame !== (this.previousReferenceFrame + 1) % (2 ** s.frameBits)) {
          this.unverified('FRAME_NUMBER_DISCONTINUITY', 'Frame number discontinuity requires unsupported gap or MMCO reset handling.');
        }
        if (nal[0] & 96) referenceFrame = frame;
        const id = isIdr ? b.ue() : -1;
        let poc = 0, delta = 0;
        if (s.poc === 0) { poc = b.read(s.pocBits); if (pps!.bottom) delta = b.se(); }
        if (pps!.redundant && b.ue() !== 0) this.unverified('REDUNDANT_PICTURE', 'Redundant pictures are unsupported.');
        if (isIdr) {
          if (slice % 5 !== 2 || frame !== 0 || !(nal[0] & 96)) bad('Invalid IDR picture.');
          if (b.read()) this.unverified('IDR_DISCARDS_PRIOR_PICTURES', 'IDR discards pending pictures (no_output_of_prior_pics_flag).');
          b.read();
        }
        const key = `${ppsId}/${frame}/${poc}/${delta}/${id}/${isIdr}`;
        if (slices && (key !== picture || idr !== isIdr)) bad('Multiple pictures in one sample.');
        idr = isIdr; picture = key; slices++;
      } else if (![6, 9, 12].includes(type)) bad(`Unsupported AVC NAL type ${type}.`);
    }
    if (!slices) bad('Sample contains no complete coded picture.');
    if (referenceFrame !== undefined) this.previousReferenceFrame = referenceFrame;
    return idr!;
  }
}
