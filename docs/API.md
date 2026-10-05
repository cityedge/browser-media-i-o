# APIと動作契約（0.2.1）

独立したMP3出力モジュール（`browser-media-io/mp3`）の仕様は [MP3.md](MP3.md) を参照してください。

対象はブラウザ内の入力・情報取得・MP4出力です。編集、字幕解析、合成、スペアナ、音声ミックスは利用アプリが担当します。
公開APIは秒単位、PCMの長さはチャンネル当たりのサンプル数です。対象はHTTPSまたはlocalhostのデスクトップChrome／Edgeです。
コーデックの対応はブラウザとOSに依存し、指定解像度などを含め `getCapabilities()` で事前確認します。

## 入力APIの選択（0.2.1）

```ts
// 既存API: デコーダーcloseまで待つ
import { openMedia as openStrict } from 'browser-media-io';
// 追加API: Mediabunnyの公開APIだけを使う
import { openMedia as openPublic } from 'browser-media-io/public';
```

両方とも同じ `MediaInput` 型を返します。`probe`、`getVideoFrame`、`videoFrames`、`videoFramesAt`、
`audioPcmBlocks`、`audioBlocks`、`close` の機能・引数・時刻境界・所有権・エラー規則は共通です。
`/public` は情報取得・音声全デコード・MP4出力・型定義も同じ名前で公開するため、import元を一箇所変更して選択できます。
AACとMP3の入口は引き続き `/aac` と `/mp3` です。

| 契約 | 従来のopenMedia | /publicのopenMedia |
|---|---|---|
| Mediabunnyへの接続 | 非公開の終了管理アダプターを含む | 公開APIのみ。アダプターをimportしない |
| return完了時の進行中next | 終了済み | 終了済み |
| 古い結果の混入防止・入力排他の解除 | 保証 | 保証 |
| return完了時の旧デコーダーclose | 待つ | 待たない。背景の後片付けが続く場合あり |
| 中止前に返却済みのフレーム | 利用側所有。個別中止では閉じない | 同じ |
| 全入力close後の再利用 | 不可 | 不可 |

/publicでも、シーク時は `abort()` → `await reader.return()` → 次のreader開始という順序を守ります。
返却待ちのnextの結果・例外は利用側で処理してください。ライブラリが管理する待機・排他の解除を完了点とし、
基盤内部の先読み処理・デコーダーの停止完了・ブラウザのメモリ回収は完了点に含めません。
反復シークでは旧処理と新処理が一時的に重なる可能性があり、終了までの固定時間は保証しません。
一つのreader内の逐次取得と先読み制御は維持しますが、重なったreader全体の資源数の上限は保証しません。

関数名で使い分けたい場合は、ルートから `openMediaPublic` もimportできます。
この関数自体は公開API版ですが、ルートのモジュールグラフには従来アダプターも存在します。
内部接続コードの読み込み自体を避けるアプリは、`browser-media-io/public` に統一してください。

Mediabunnyの依存は、従来APIと共存するこのパッケージでは引き続き1.61.0に固定します。
公開API版の追加は任意バージョンへの互換保証ではありません。依存を更新する場合の検証範囲は別途判断します。
以下の共通API例はルートを使っています。/publicへ置き換えた場合、終了保証はこの節の契約になります。

## 情報取得

```ts
import { probe } from 'browser-media-io';
const info = await probe(file); // デフォルトは全パケット走査
const quick = await probe(file, { mode: 'metadata' });
```

- 0.2のコンテナ: MP4/M4A、MP3、WAV。入力は `File` または `Blob`。
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

## 映像・音声の区間取得（0.2）

```ts
import { openMedia } from 'browser-media-io';
const media = await openMedia(file, { maxOutstandingFrames: 8 });
try {
  for await (const frame of media.videoFrames({ start: 10, end: 12 })) {
    try { frame.draw(context); } finally { frame.close(); }
  }
  const times = function* () { for (let n = 0; n < 60; n++) yield 10 + n / 30; };
  for await (const { time, frame } of media.videoFramesAt(times())) {
    try { if (frame) frame.draw(context); } finally { frame?.close(); }
    // timeは要求時刻。frame.timestampは元素材の表示時刻。
  }
} finally { media.close(); }
```

| API | 返却値・区間 |
|---|---|
| `getVideoFrame(t,{trackId?,signal?})` | tで表示されるMediaFrame、またはnull |
| `videoFrames({start?,end?,trackId?,signal?})` | `[start,end)` と表示区間が重なる元フレームを表示順に返すMediaReader |
| `videoFramesAt(times,{trackId?,signal?})` | 各要求時刻の `{time,frame:MediaFrame|null}` を返すMediaReader |
| `audioPcmBlocks({start?,end?,trackId?,signal?,maxBlockSamples?})` | 元時刻付きの、利用側所有のplanar Float32 PCM |
| `audioBlocks(同じ引数)` | `{timestamp,buffer:AudioBuffer}`。Window向け互換API |

startは既定0、endは既定Infinity。時刻は秒単位の有限・非負数（endだけInfinity可）、end > start。
videoFramesAtには同期の `Iterable<number>` を渡します。単調非減少で、同じ時刻の反復は可能です。
逆向きシークはreaderを終了してから新しい列で開始してください。時刻列を全件展開せず、必要な分だけ消費します。
各readerの `next()` は一つずつawaitします。同時のnextはBUSYです。

フレームの表示区間は `[timestamp,timestamp+duration)`。videoFramesはstartで既に表示中のフレームを含み、
startで終了するフレーム、endで開始するフレーム、durationが0のフレームを除外します。
videoFramesAt／getVideoFrameは先頭より前、表示区間の空白、末尾の終了時刻以降でnullです。
終了時刻に次のフレームが始まれば次を選択します。空白を直前のフレームで埋めません。
比較対象の各時刻・境界は `Math.round(seconds * 1e6)` で整数µsに正規化し、安全な整数範囲を超える要求は拒否します。
サブµsの区別は保証しません。返却するtimestamp／durationは元sampleの値です。

同じ元フレームを複数回返しても、返却ハンドルは独立してcloseできます。既定8枚の未解放ハンドルでRESOURCE_LIMIT。
返却済みハンドルをcloseしてから次を読みます。上限はreader終了後も入力単位で維持されます。
ファイルキャッシュは入力ごとに既定8MiB（readCacheBytes）。デコーダーの参照画像や基盤のキューは別です。
videoFramesAtは現在フレームと次フレームを内部保持し、1秒を超える要求時刻のジャンプでは読み取りを作り直します。
消費側が止まればデコード側も待ちますが、全内部メモリの厳密な上限や先読み枚数の設定APIはありません。

### キャンセルと入力再利用

同じMediaInputの読み取り・probeは排他的です。使用中はBUSYになります。
同じBlobを別々にopenMediaすれば映像／音声／プレビューを並行処理できます。Blobの全量複製は不要ですが、
キャッシュ・解析情報・デコーダーのメモリは各入力に必要です。

```ts
const controller = new AbortController();
const reader = media.videoFrames({ signal: controller.signal });
const pending = reader.next().then(item => {
  if (!item.done) item.value.close();
}, error => {
  if (error.code !== 'ABORTED') throw error;
});
controller.abort();          // 中止要求。これだけでは再利用完了ではない
await reader.return();       // 旧デコーダーのcloseと排他解除を待つ完了点
await pending;              // 進行中nextの結果・例外は呼び出し側でも処理する
const frame = await media.getVideoFrame(5);
frame?.close();
```

returnは反復可能です。従来のopenMediaでは、待機中nextを終了させ、未返却フレームと旧デコーダーを解放してから成功します。
/publicでは待機中nextとラッパーの解放処理を終了させ、基盤のデコーダーcloseは待ちません。
個別abortではnextがABORTEDになり、返却済みフレームは閉じません。returnだけでの終了時も、
競合して進行中だったnextはdoneまたはABORTEDになり得るため、Promiseを放置しないでください。
自然終了と `for await` のbreakも終了処理を待ちます。returnに失敗した入力は閉じられ、再利用できません。
固定時間内の停止やGC完了は保証しません。

単発getVideoFrame／probeはそのPromiseの終了が再利用完了点です。probeにも個別signalを渡せます。
openMediaのsignalは入力全体の寿命で、abortすると入力と未解放MediaFrameを閉じます。
closeは反復可能ですが入力の再利用はできません。進行中readerのreturnも待ってください。
入力closeは、既に返されたPCM配列／AudioBufferやtoVideoFrameの別所有フレームまでは閉じません。

Mediabunny 1.61.0のreturn単体では背景デコーダー終了を待てないため、内部の二つのinstance hookを
`src/decoder-session.ts` で限定的に接続しています。この処理は従来のopenMediaだけが使います。
/publicは `src/public-decoder-session.ts` から公開iterator.returnだけを呼びます。
実際のdecoder.closeの観測と、別タスクを残さないパケット逐次取得を組み合わせています。
依存は1.61.0へ完全固定し、更新時には初期化中／next待機中／yield中の中止・再開テストを必須とします。

### PCMの所有権とWorker

```ts
interface PcmAudio {
  sampleRate: number;
  numberOfChannels: number;
  length: number;                  // チャンネル当たりのサンプル数
  channelData: Float32Array[];     // チャンネルごとにlength個
}
interface PcmBlock extends PcmAudio { timestamp: number }

for await (const pcm of audioInput.audioPcmBlocks({ start: 1, end: 5, maxBlockSamples: 4096 })) {
  await writer.addPcm(pcm); // レート／チャンネル数を出力と揃える。timestampは配置に使われない
}
```

音声区間はサンプル開始時刻が `[start,end)` に入るサンプルへ切り揃えます。
ブロックの最大長は既定4096、指定可能範囲1～65536。境界では短いブロックを返します。
元レート・チャンネル数・元timestampを保持し、リサンプリングや空白埋めはしません。
返却配列はコピー済みの通常のArrayBufferで、次の読み取りでも書き換えません。close不要で、transfer可能です。
内部ではコピー元のデコードsampleをブロック分割中だけ保持し、使い終わりにcloseします。

addPcmは配列を借用し、detachしません。完了まで内容を書き換えたりtransferしたりしないでください。
最大4096サンプル×チャンネル数のFloat32コピーを順にコーデックへ渡します（コーデックの内部コピーは別）。
長さ／配列数の不整合、NaN／Infinity、レート／チャンネル数の不一致を拒否します。通常の振幅は-1～1を使用します。
追加完了後は同じ配列を再利用できます。出力時刻は0からの累積整数サンプル数で決まり、PcmBlock.timestampは無視します。
曲の配置、無音、フェード、ミックスはアプリで準備してください。

Dedicated WorkerではopenMedia、probe、映像取得、audioPcmBlocks、createMp4Writer／addPcmを利用できます。
audioBlocks、decodeAudio、addAudioはWindowのAudioBufferに接続する補助APIです。
AAC拡張は実行するWorker内でenableAacFallbackを呼びます。
[Worker・WebGL出力例](../examples/worker-export.ts) と [実Worker起動のテスト例](../tests/web/harness/gpu.ts) を参照してください。

### 表示変換とWebGL

MediaFrameはtimestamp、duration、width／height（変換後の表示寸法）、rotation（時計回り）、
flip（回転後の水平反転）、squarePixelWidth／squarePixelHeight（回転前の正方画素での表示寸法）を公開します。
drawはアスペクト比・回転・反転を適用します。toVideoFrameは独立所有のネイティブフレームを返しますが、
これらの表示変換を画素へ焼き込みません。GPU側は回転前の表示寸法を基準に、rotation、次にflipを適用します。
0／90／180／270度と水平反転を対象にし、せん断・任意のアフィン変換は対象外です。

[WebGL描画例](../examples/webgl-frame.ts) はVideoFrameのvisibleRectを使うテクスチャアップロードと、
表示寸法を使うviewportを組み合わせます。visibleRectで二重にクロップしません。
素材の水平flipと、WebGLのテクスチャ上下方向は別に扱います。
直接Canvasを渡す例ではpreserveDrawingBufferを有効にし、VideoFrameの例では描画直後にスナップショットします。
元ハンドル、テクスチャ用VideoFrame、出力VideoFrame、GPU資源はそれぞれ解放してください。
色域・レンジ・圧縮による数値変化を含み、マットの画素値が往復で完全一致する保証はありません。
測定値と検証範囲は [0.2評価結果](VALIDATION_0.2.md) を参照してください。

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
- 中止要求後は新しいフレーム・PCMの追加を止め、処理中のコーデック操作が完了してから資源を解放します。
  初期化中のAAC Workerを先に終了して待機処理が残るのを防ぐため、中止の完了まで短い待ち時間が生じます。
  アプリ独自のストリームの書き込みが終了しない場合などに、中止が一定時間以内で完了する保証はありません。
- ビットレートは映像8Mbps、音声192kbpsが既定。`videoBitrate`、`audioBitrate` で変更します。

## AACの明示的な拡張

```ts
import { enableAacFallback } from 'browser-media-io/aac';
await enableAacFallback({ sampleRate: 48000, channels: 2 });
```

別途 `npm install --save-exact mediabunny@1.61.0 @mediabunny/aac-encoder@1.61.0` が必要です。
本体と拡張が同じMediabunnyを使用するよう、利用アプリでも1.61.0へ完全固定してください。
異なる版が別々にインストールされると、拡張の登録が本体へ反映されずUNSUPPORTEDになる場合があります。ネイティブAAC対応なら `native`、
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
- 音声を使う場合は作成時に `audio:{sampleRate,channels,codec?,bitrate?}` を指定し、同じ構成のPCMを `addPcm()`、または `AudioBuffer` を `addAudio()` へ渡します。
- 音声は0から連続追加です。空白区間・ミックスはアプリでPCMを用意します。長い出力は映像と音声を交互に追加してください。
- `expectedFrames` を省略すれば、映像と音声の長さを揃えて追加を止め、finishで正常に早期終了できます。cancelは破棄です。
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

0.2で保証するのは現在の自動テストの範囲です。長時間4K、任意の破損ファイル、モバイル、
ブラウザごとの色管理差などは検証範囲を広げる段階です。
