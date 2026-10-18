// JavaScript adaptation of the bundled upstream mp3/VBROldIterationLoop.java.
// LAME / lamejs contributors; modifications for Browser Media I/O. LGPL-3.0.
var { new_float, new_float_n, new_int, new_int_n } = require('./common.js');
var MeanBits = require('./MeanBits.js');
var L3Side = require('./L3Side.js');
function VBROldIterationLoop(quantize) {
  this.iteration_loop = function(gfp, pe, ms_ener_ratio, ratio) {
    var gfc = gfp.internal_flags;
    var xmin = new_float_n([2,2,L3Side.SFBMAX]);
    var xrpow = new_float(576), bands = new_int_n([2,2]);
    var frameBits = new_int(15), minBits = new_int_n([2,2]), maxBits = new_int_n([2,2]);
    var silence = quantize.VBR_old_prepare(gfp, pe, ms_ener_ratio, ratio, xmin, frameBits, minBits, maxBits, bands);
    var mean = new MeanBits(0);
    for(var attempt=0;;attempt++) {
      if(attempt>=128) throw new Error('VBR bit allocation did not converge');
      var used = 0;
      for(var gr=0;gr<gfc.mode_gr;gr++) for(var ch=0;ch<gfc.channels_out;ch++) {
        var info = gfc.l3_side.tt[gr][ch];
        if(!quantize.init_xrpow(gfc,info,xrpow)||maxBits[gr][ch]===0) continue;
        quantize.VBR_encode_granule(gfp, info, xmin[gr][ch], xrpow, ch, minBits[gr][ch], maxBits[gr][ch]);
        if(gfc.substep_shaping & 1) quantize.trancate_smallspectrums(gfc,info,xmin[gr][ch],xrpow);
        used += info.part2_3_length + info.part2_length;
      }
      gfc.bitrate_index = silence && !gfp.VBR_hard_min ? 1 : gfc.VBR_min_bitrate;
      while(gfc.bitrate_index<gfc.VBR_max_bitrate && used>frameBits[gfc.bitrate_index]) gfc.bitrate_index++;
      var available = quantize.rv.ResvFrameBegin(gfp,mean);
      if(used<=available) break;
      quantize.bitpressure_strategy(gfc,xmin,minBits,maxBits);
    }
    for(var gr=0;gr<gfc.mode_gr;gr++) for(var ch=0;ch<gfc.channels_out;ch++) quantize.iteration_finish_one(gfc,gr,ch);
    quantize.rv.ResvFrameEnd(gfc,mean.bits);
  };
}
module.exports = VBROldIterationLoop;
