# 初版APIと動作契約（0.1.0）

対象はブラウザ内の入力・情報取得・MP4出力です。編集、字幕解析、合成、スペアナ、音声ミックスは利用アプリが担当します。
公開APIは秒単位、PCMの長さはチャンネル当たりのサンプル数です。対象はHTTPSまたはlocalhostのデスクトップChrome／Edgeです。
コーデックの対応はブラウザとOSに依存し、指定解像度などを含め `getCapabilities()` で事前確認します。

## 情報取得

```ts
import { probe } from 'browser-media-io';
const info = await probe(file); // デフォルトは全パケット走査
const quick = await probe(file, { mode: 'metadata' });
```

- 初版のコンテナ: MP4/M4A、MP3、WAV。入力は `File` または `Blob`。
- 結果: MIMEタイプ、ファイルサイズ、トラック一覧、コーデック、デコード可否、長さ。
- 映像: 表示サイズ、回転、走査から得た平均fpsとフレーム間隔の傾向。
- 音声: 元トラックのサンプルレートとチャンネル数。
- 各トラックに `metadataDuration` と `duration: {seconds,source}` を持ちます。
- `source` は `metadata` または `packets`。走査はパケット時刻・長さの検査であり、音声の全デコードではありません。
- 長さはタイムラインの終端時刻です。正の開始時刻のトラックは先頭の空き時間を含みます。走査結果は `startTime` も返します。
- メタデータ取得だけではfps、開始時刻、パケット数は `null`、周期は `unknown` です。値を推測して埋めません。
- `packetCount` は圧縮パケット数です。一般のコーデックでデコードフレーム数と等しいとは保証しません。
- 可変fpsの `averageFrameRate` は平均値です。シークは素材の実タイムスタンプに従います。
- `onProgress({trackId,packets})` を任意指定できます。総パケット数を知らないため比率は返しません。

## 音声の全デコード

```ts
import { decodeAudio } from 'browser-media-io';
const audio = await decodeAudio(file, { sampleRate: 48000, signal });
// audio.buffer: AudioBuffer
// audio.sampleCount / audio.sampleRate === audio.duration
// audio.durationSource === 'decoded-samples'
```

Web Audioの全デコード結果を返します。誤ったヘッダー値を長さの根拠に使いません。
既定は48kHzで、指定サンプルレートへの変換を伴います。元のレートは `probe` で取得できます。
これは単体音源をPCMとして扱う補助APIで、元のコンテナの開始時刻や複数音声トラックの選択は扱いません。
元動画との同期・トラック選択が必要な場合は `audioBlocks` のタイムスタンプを使用してください。

`maxInputBytes` は既定128MiB、`maxDecodedBytes` は既定512MiBです。
前者はデコード前、後者はデコード後に検査します。後者はブラウザ内部のピークメモリの上限ではありません。
長尺には区間デコードを使ってください。`decodeAudioData` 自体は中断できないため、キャンセルで待機を終了しても
ブラウザ内部の処理が一時的に続く場合があります。

## 映像・音声の区間取得

```ts
import { openMedia } from 'browser-media-io';
const media = await openMedia(file, { signal, maxOutstandingFrames: 8 });
try {
  const frame = await media.getVideoFrame(12.5);
  if (frame) {
    try { frame.draw(context); }
    finally { frame.close(); }
  }
  for await (const { buffer, timestamp } of media.audioBlocks({ start: 10, end: 12 })) {
    // アプリがPCMと元のタイムスタンプを利用する
  }
} finally { media.close(); }
```

- `getVideoFrame(t,{trackId?})`: 時刻tで表示されるフレーム。範囲外は `null`。
- 境界はWebCodecsのµs精度に合わせます。フレーム補間は行いません。
- ハンドルは `timestamp`、`duration`、表示サイズ、回転、`draw()`、`close()` を持ちます。
- `draw()` は回転・反転を適用します。`toVideoFrame()` は独立したネイティブフレームを返し、呼び出し側が別途解放します。
- 既定8枚の未解放ハンドルで上限に達します。閉じると次のフレームを取得できます。
- `audioBlocks({start?,end?,trackId?})`: `[start,end)` の音声をPCMブロックで返します。サンプル境界に切り揃えます。
- ファイル読み取りキャッシュは既定8MiB。`readCacheBytes` で変更できます。コーデック内部の参照フレームなどのメモリは別です。
- 同じ `MediaInput` 上の操作は一つずつawaitしてください。同時呼び出しは `BUSY` です。別々の入力は並行利用できます。
- `openMedia` に渡すsignalは入力全体の寿命です。abortは入力と未解放ハンドルを閉じます。再利用時は新しく開きます。
- `close()` は複数回呼べます。音声ブロックの `AudioBuffer` は通常のJSオブジェクトとして呼び出し側が保持します。

## CanvasからのMP4生成

```ts
import { renderMp4 } from 'browser-media-io';
const result = await renderMp4({
  width: 1280, height: 720, fps: 30, duration: audio.duration,
  audio: audio.buffer,
  signal,
  onProgress: progress => console.log(progress.fraction),
  renderFrame(context, time, frameIndex) {
    context.fillStyle = '#102030'; context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#fff'; context.font = '48px sans-serif';
    context.fillText(time.toFixed(2), 80, 100);
  },
});
// result.blob をダウンロードなどに使う
```

- H.264、音声指定時はAACが既定です。音声なしも可能です。Opusは `audioCodec: 'opus'` で明示指定します。
- `renderFrame` はasyncでも構いません。ライブラリが全フレームを順番にawaitします。
- fpsは数値または `{numerator:30000,denominator:1001}`。範囲は1〜240、解像度は正の偶数です。
- フレーム数は `ceil(duration * fps)`。端数があると最終時間は最大1フレーム分長くなります。
- 第nフレームは `frameTime(n,fps)`。繰り返し加算で時計を進めません。
- 各フレームのCanvas状態をリセットします。フレーム間の状態はアプリの変数で管理してください。
- 音声は0秒開始。動画の終端に合わせて切り詰め・無音埋めし、整数サンプル数から時刻を計算します。
- 音声はブロックに分けて映像と交互に送り、ライブラリ内部で全非圧縮動画を保持しません。
- キャンセル時に完成ファイルは返しません。`renderFrame` 内の独自処理の停止・資源解放はアプリの責任です。
- ビットレートは映像8Mbps、音声192kbpsが既定。`videoBitrate`、`audioBitrate` で変更します。

## AACの明示的な拡張

```ts
import { enableAacFallback } from 'browser-media-io/aac';
await enableAacFallback({ sampleRate: 48000, channels: 2 });
```

別途 `npm install @mediabunny/aac-encoder@1.61.0` が必要です。ネイティブAAC対応なら `native`、
非対応なら拡張を動的ロードして登録し `wasm` を返します。登録はそのJS実行領域で共有されます。
メインのエントリーポイントはこの拡張を自動ロードしません。AACから別のコーデックへの自動変更もありません。
拡張のWASMは配布パッケージに含まれ、実行時にFFmpegサーバーや外部サービスを呼びません。
固定した拡張バージョン1.61.0のAAC先頭遅延（1024サンプル）は出力タイムスタンプで補正し、
MP4の編集リストで除去します。ネイティブAACにはこの補正を適用しません。拡張を更新する際は同期テストも必要です。

## 低レベルの書き出し

```ts
import { createMp4Writer } from 'browser-media-io';
const writer = await createMp4Writer({ width: 1280, height: 720, fps: 30, expectedFrames: 90 });
try {
  for (let n = 0; n < 90; n++) {
    drawYourFrame(canvas, n / 30);
    await writer.addVideoFrame(canvas);
  }
  const result = await writer.finish();
} catch (error) {
  await writer.cancel();
  throw error;
}
```

- 入力は呼び出し側の所有です。`addVideoFrame` は渡されたVideoFrameを閉じません。
- 映像のサイズは設定と一致させてください。時刻は追加順に割り当て、元素材の時刻は上書きします。
- 音声を使う場合は作成時に `audio:{sampleRate,channels,codec?,bitrate?}` を指定し、同じ構成の `AudioBuffer` を `addAudio()` へ渡します。
- 音声は0から連続追加です。空白区間・ミックスはアプリでPCMを用意します。長い出力は映像と音声を交互に追加してください。
- `finish()` は映像0枚、設定した予定枚数との不一致、1映像フレームを超える音声長の不一致を拒否します。
- 非同期操作を一つずつawaitしてください。並列追加は `BUSY` です。
- 実行中のデータエラーはwriterを終了させます。再試行は新しいwriterを作成してください。
- 成功時は `finished`、キャンセルは `cancelled`、異常終了は `failed` になります。

## 保存先・上限・エラー

`target` の既定は `{kind:'blob',maxBytes:256*1024*1024}` です。ページ単位で保持し、完成後にBlobを返します。
制限はライブラリが保持する出力バイト列の上限で、ブラウザ全体のメモリ保証ではありません。

直接保存には `{kind:'stream',stream}` を渡します。ストリームは `{type:'write',position,data}` を受け取り、
positionで指定された位置を上書きできる必要があります。`FileSystemWritableFileStream` と互換です。
ライブラリがストリームを所有し、成功時はclose、失敗・キャンセル時はabortします。取得前にコーデック対応を調べると便利です。
通常のMP4を作るため、メタデータは末尾です。非圧縮映像全体の保持はしませんが、コンテナの索引は尺に応じて増えます。

エラーは `MediaError` の `code` で判別します。
`INVALID_ARGUMENT`、`UNSUPPORTED`、`CLOSED`、`BUSY`、`ABORTED`、`RESOURCE_LIMIT`、`DECODE_FAILED`、`ENCODE_FAILED`。
進捗比率が1になるのはファイルの確定後のみです。コールバックからの例外は処理失敗として扱います。

初版で保証するのは現在の自動テストの範囲です。長時間4K、任意の破損ファイル、モバイル、
ブラウザごとの色管理差などは検証範囲を広げる段階です。
