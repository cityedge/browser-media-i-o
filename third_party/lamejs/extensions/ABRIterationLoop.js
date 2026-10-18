// Adapted from the bundled upstream mp3/ABRIterationLoop.java (LAME / lamejs).
// Modifications for Browser Media I/O; LGPL-3.0.
var { new_float, new_int, new_int_n } = require('./common.js');
var MeanBits = require('./MeanBits.js');
var L3Side = require('./L3Side.js');
var Encoder = require('./Encoder.js');
function ABRIterationLoop(quantize) {
  this.iteration_loop = function(gfp,pe,msRatio,ratio) {
    var gfc=gfp.internal_flags, xmin=new_float(L3Side.SFBMAX), xrpow=new_float(576);
    var targets=new_int_n([2,2]), silence=new_int(1), maximum=new_int(1);
    quantize.calc_target_bits(gfp,pe,msRatio,targets,silence,maximum);
    for(var gr=0;gr<gfc.mode_gr;gr++) {
      if(gfc.mode_ext===Encoder.MPG_MD_MS_LR) quantize.ms_convert(gfc.l3_side,gr);
      for(var ch=0;ch<gfc.channels_out;ch++) {
        var info=gfc.l3_side.tt[gr][ch];
        gfc.masking_lower=Math.pow(10,(info.block_type===Encoder.SHORT_TYPE?gfc.PSY.mask_adjust_short:gfc.PSY.mask_adjust)*0.1);
        quantize.init_outer_loop(gfc,info);
        if(quantize.init_xrpow(gfc,info,xrpow)) {
          if(!quantize.qupvt.calc_xmin(gfp,ratio[gr][ch],info,xmin)) targets[gr][ch]=silence[0];
          quantize.outer_loop(gfp,info,xmin,xrpow,ch,targets[gr][ch]);
        }
        quantize.iteration_finish_one(gfc,gr,ch);
      }
    }
    var mean=new MeanBits(0);
    for(gfc.bitrate_index=gfc.VBR_min_bitrate;gfc.bitrate_index<=gfc.VBR_max_bitrate;gfc.bitrate_index++) {
      if(quantize.rv.ResvFrameBegin(gfp,mean)>=0) break;
    }
    if(gfc.bitrate_index>gfc.VBR_max_bitrate) throw new Error('ABR frame exceeds maximum bitrate');
    quantize.rv.ResvFrameEnd(gfc,mean.bits);
  };
}
module.exports=ABRIterationLoop;
