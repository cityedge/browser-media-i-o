# Third-party dependencies

Browser Media I/O's original sources are MIT licensed. Dependencies retain their own licenses.

## Mediabunny 1.61.0 — MPL-2.0

Author: Vanilagy and contributors.
Used for container parsing/writing, media sinks/sources, and codec integration.
Unmodified dependency. [Package](https://www.npmjs.com/package/mediabunny/v/1.61.0) /
[versioned source](https://github.com/Vanilagy/mediabunny/tree/v1.61.0).

## @mediabunny/aac-encoder 1.61.0 — MPL-2.0

Author: Vanilagy and contributors.
Unmodified extension using a prebuilt WebAssembly build of FFmpeg's AAC encoder.
[Package](https://www.npmjs.com/package/@mediabunny/aac-encoder/v/1.61.0) /
[source and build instructions](https://github.com/Vanilagy/mediabunny/tree/v1.61.0/packages/aac-encoder).
FFmpeg retains its [upstream licensing](https://ffmpeg.org/legal.html);
its [source](https://github.com/FFmpeg/FFmpeg) and LGPLv2.1 license are separate from MPL.

The npm core does not automatically load this optional extension. The classic-script bundles explicitly
include its inline WASM and share one bundled Mediabunny instance; call enableAacFallback before AAC output.

## @breezystack/lamejs 1.2.7 — LGPL-3.0

Authors: Alex Zhukov, the LAME project and fork contributors.
[Package](https://www.npmjs.com/package/@breezystack/lamejs/v/1.2.7) /
[exact upstream source](https://github.com/shijinyu/lamejs/tree/1fb0ef5fa177413107e2e107d054a9b994e3f79c).
Unmodified encoder bundled into the MP3 Blob worker. The npm core MP4 entry does not include it.
The classic all-in-one bundles and the dedicated BrowserMp3 script include it.

In the repository and matching source ZIP, third_party/lamejs/source.tar.gz contains corresponding
upstream source/build files. COPYING and COPYING.LESSER contain GPLv3 and LGPLv3.
The standalone MP3 ZIP includes these license texts; the source archive is in the matching source ZIP.

## Source availability and replacement

The classic-script and standalone MP3 ZIPs contain the library, optional example, notices and license texts.
The matching browser-media-io-sources-<version>.zip contains our wrapper/build sources and lockfile,
LAME's corresponding source, and the complete Mediabunny v1.61.0 source archive including AAC build inputs.
Publish the matching source ZIP alongside the binaries on
[GitHub Releases](https://github.com/cityedge/browser-media-i-o/releases).
Provenance and fixed hashes for downloaded materials are recorded in third_party/SOURCES.json.

See [source and rebuilding instructions](https://github.com/cityedge/browser-media-i-o/blob/main/docs/SOURCES.md)
(also SOURCES.md in both binary ZIPs). Modified dependencies can be rebuilt and relinked into the
classic scripts; no signing key is required. Preserve notices, licenses and source availability when redistributing.
The original wrapper's MIT license does not replace dependency licenses.

Playwright, Vite, TypeScript and local FFmpeg/ffprobe are development/test tools, not browser runtime prerequisites.
