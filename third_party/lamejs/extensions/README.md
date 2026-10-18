# JavaScript VBR / ABR extensions

Modified 2026-10-18 for Browser Media I/O. These files are LGPL-3.0 derivative works of the
LAME/lamejs encoder, not an independently licensed replacement for LAME. Retain the authorship
and license notices in the corresponding source archive and the adjacent COPYING files.

Base: shijinyu/lamejs, commit 1fb0ef5fa177413107e2e107d054a9b994e3f79c, version 1.2.7.
The adjacent source.tar.gz contains the corresponding source, including src/main/java/mp3/.

- VBROldIterationLoop.js adapts VBROldIterationLoop.java to the existing JavaScript quantizer.
  It selects frame sizes using the RH psychoacoustic quantization path. The retry loop is bounded.
- ABRIterationLoop.js adapts ABRIterationLoop.java using the existing target-bit calculation.
- scripts/prepare-lamejs.mjs fixes missing imports, instance qualifiers, interpolation and
  Java integer conversions in previously unused paths. It exposes mode/quality/target options,
  preserves the input sample rate for VBR/ABR and propagates encoder errors.

CBR remains the default, with its original sample-rate selection and disabled bit reservoir.
The newer MTRH quantizer remains unimplemented and is not exposed. There is no WASM or
Emscripten-generated runtime here. logue/libmp3lame-js was used to investigate feasibility;
its compiled JavaScript is not included in this encoder.

Run npm run build from the project root to reapply the changes and bundle the encoder.
The npm @breezystack/lamejs package is retained as a regression reference and for its license notice;
its prebuilt binary is not bundled into the modified worker.
