# Corresponding source for @breezystack/lamejs 1.2.7

`source.tar.gz` is an unmodified `git archive` of upstream commit
`1fb0ef5fa177413107e2e107d054a9b994e3f79c`, the npm 1.2.7 package's `gitHead`:

https://github.com/shijinyu/lamejs/tree/1fb0ef5fa177413107e2e107d054a9b994e3f79c

It includes the preferred JavaScript sources, upstream notices and build files.
No upstream code was changed. `COPYING` and `COPYING.LESSER` are the full GPLv3
and LGPLv3 license texts. See also the package's LICENSE notice and
https://lame.sourceforge.io/ . The wrapper's MIT license does not replace these terms.

To rebuild the encoder, extract the archive, install its build dependencies
(pnpm-lock.yaml / package.json) and run its `build` script. To replace the encoder
in Browser MP3, install the rebuilt package in the wrapper's source project and
run `npm run build`. The matching `browser-media-io-sources-<version>.zip`
includes this archive, the wrapper source, build scripts and package lock so it
can be rebuilt with a modified encoder. The standalone MP3 ZIP includes the
license texts and `SOURCES.md` with source download instructions.
