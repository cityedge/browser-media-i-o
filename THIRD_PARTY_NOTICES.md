# Third-party dependencies

The original Browser Media I/O sources are licensed under the repository's MIT license.
No source code from JIZURA is included.

## Mediabunny 1.61.0

- Author: Vanilagy and contributors.
- Package license: Mozilla Public License 2.0 (MPL-2.0).
- Package and versioned source: https://www.npmjs.com/package/mediabunny/v/1.61.0
- Repository: https://github.com/Vanilagy/mediabunny
- Used for container parsing/writing, codec integration, and bounded media sinks/sources.
- It is an external, unmodified npm dependency. Its source and license accompany the dependency package.

## Optional @mediabunny/aac-encoder 1.61.0

- Author: Vanilagy and contributors.
- Package license: MPL-2.0.
- Package and source: https://www.npmjs.com/package/@mediabunny/aac-encoder/v/1.61.0
- Repository and build instructions: https://github.com/Vanilagy/mediabunny/tree/main/packages/aac-encoder
- Uses a WebAssembly build of FFmpeg's AAC encoder (libavcodec). Refer also to the upstream FFmpeg licensing and source at https://ffmpeg.org/legal.html.
- External, unmodified, optional dependency; not bundled into the core entry point.

These dependencies retain their own licenses. Redistributing an application with them requires preserving
their notices and meeting the applicable source availability requirements. The repository's MIT license
does not replace their licenses.

Playwright, Vite, TypeScript and the locally installed FFmpeg/ffprobe are development and test tools;
they are not required by the browser-side core at runtime.
