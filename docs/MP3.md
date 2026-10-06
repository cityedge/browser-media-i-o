# WAV出力にMP3の選択肢を追加する

完成済み音声を一括変換する小さなモジュールです。リアルタイム録音・再生は使いません。
MP4機能、Mediabunny、WebCodecs、AudioContext、サーバーでの変換は不要です。
MP3エンコーダーは同梱され、Worker内で処理します。変換中の外部通信はありません。

## すでにWAVのBlobを作れるアプリ

```ts
import { wavToMp3 } from 'browser-media-io/mp3';

const wavBlob = createWav(); // アプリがすでに持っているWAV生成処理
const blob = format === 'mp3' ? await wavToMp3(wavBlob) : wavBlob;
const filename = `output.${format}`; // format は 'wav' または 'mp3'
// 以降は既存のBlob保存処理へ。MIMEタイプはMP3の場合 audio/mpeg。
```

WAVを作る前のAudioBufferが残っていれば、中間のWAV生成を省けます。

```ts
import { encodeMp3 } from 'browser-media-io/mp3';
const mp3Blob = await encodeMp3(audioBuffer);
```

このサブモジュールは基本の `browser-media-io` から再exportしません。
MP3を使うアプリだけが明示的にimportします。どちらの関数も `Promise<Blob>` を返します。

## 通常のHTMLへの組み込み

MP3専用の `browser-mp3-0.4.0.zip`、またはビルドで生成した `dist/standalone/` を使用します。
エンコーダーを含む `browser-mp3.js` と、WAV/MP3の切り替えを試せる `index.html` が入っています。
JavaScriptファイルは約177 KB（非圧縮）。実行時のnpmインストールやCDNは不要です。
MP3専用ZIPにはライセンス文書とソースの入手案内を含めています。
変更・再ビルド用ソースは、同じReleaseの `browser-media-io-sources-0.4.0.zip` に分離しています。
利用アプリでの実行にソースZIPは不要です。

```html
<script src="browser-mp3.js"></script>
<script>
  async function saveAsMp3(wavBlob) {
    const mp3Blob = await BrowserMp3.wavToMp3(wavBlob);
    const url = URL.createObjectURL(mp3Blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'output.mp3';
    link.click();
    // アプリでは再生成・画面終了時などに不要なURLを解放してください。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
</script>
```

サンプルのソースは [examples/mp3-export/index.html](../examples/mp3-export/index.html) です。
`npm run build` で生成する `dist/standalone/` に、JSとサンプルHTMLが揃います。

## 関数とオプション

```ts
encodeMp3(audio: Mp3Audio, options?: Mp3Options): Promise<Blob>
wavToMp3(wav: Blob | ArrayBuffer, options?: WavToMp3Options): Promise<Blob>
```

`Mp3Audio` はAudioBuffer、または同じ `sampleRate`、`numberOfChannels`、`length` と
`getChannelData(channel): Float32Array` を持つオブジェクトです。チャンネルごとに同じサンプル数が必要です。
入力を変更・detachしません。処理が終わるまでアプリ側でも入力を変更しないでください。
有限のPCM値は -1～1 にクリップし、16bitへ量子化してエンコーダーに渡します。
NaN／Infinityはエラーです。

| オプション | 内容 |
|---|---|
| `bitrate` | bit/s単位のCBR。通常は192000。32 kHz未満の入力は既定128000 |
| `signal` | AbortSignal。中止時はWorkerを終了し、`code: 'ABORTED'` のMediaErrorでreject |
| `onProgress` | 0～1の数値を受ける関数。1はファイル完成後のみ |
| `maxOutputBytes` | MP3の上限。既定256 MiB |
| `maxInputBytes` | `wavToMp3` のWAV入力上限。既定256 MiB。Blobを読む前に検査 |

```ts
const controller = new AbortController();
const blob = await wavToMp3(wavBlob, {
  bitrate: 192000,
  signal: controller.signal,
  onProgress: fraction => { progressElement.value = fraction; },
});
// 中止ボタンなどから controller.abort()
```

エラーには `INVALID_ARGUMENT`、`UNSUPPORTED`、`RESOURCE_LIMIT`、`ABORTED`、`ENCODE_FAILED`
のコードがあります。失敗・中止時は部分ファイルを返しません。進捗コールバックの例外も変換を終了させます。
複数の変換は独立したWorkerで実行します。

## 対応範囲

- モノラル／ステレオ。多チャンネルの自動ダウンミックスは行いません。
- 入力サンプルレート: 8 / 11.025 / 12 / 16 / 22.05 / 24 / 32 / 44.1 / 48 kHz。
  96 kHz等はアプリ側でリサンプリングしてから渡してください。
- 32 kHz以上の入力のビットレート: 32 / 40 / 48 / 56 / 64 / 80 / 96 / 112 / 128 / 160 / 192 / 224 / 256 / 320 kbps。
- 32 kHz未満: 8 / 16 / 24 / 32 / 40 / 48 / 56 / 64 / 80 / 96 / 112 / 128 / 144 / 160 kbps。
  低ビットレート指定時はエンコーダーが出力サンプルレートを下げることがあります。
- WAV: little-endianのRIFF/WAVE、整数PCM 8/16/24/32bit、浮動小数点PCM 32/64bit。
  PCM/floatのWAVE_FORMAT_EXTENSIBLEにも対応します。圧縮WAV、RF64、複数dataチャンク、
  格納ビット数と有効ビット数が異なる形式には対応しません。
- 音声はメモリ上に存在する前提です。WAV入力はファイル全体を読み、PCMはブロックごとに変換します。
  MP3全体もBlob生成まで保持します。容量上限はプロセス全体のピークメモリ保証ではありません。
- ID3タグ・ジャケット・VBR・ギャップレス再生用タグの付与は初版の範囲外です。
  CBRの実データに基づく再生時間になりますが、圧縮処理の遅延と末尾の余白が加わります。
  44.1/48 kHzでは合計約50 ms以内をテストで確認します。サンプル単位で元の長さと一致する仕様ではありません。

デスクトップChromiumとWindows Chrome/Edgeで検証しています。Firefox／Safari／モバイルは未検証です。
WebCodecsやHTTPSはモジュール自体の必須条件ではありませんが、Web WorkerとBlob URLが必要です。
CSPを設定するアプリでは `worker-src 'self' blob:` を許可してください。
同じMP3実装を含む通常script版はWindows Chrome/Edgeでfile://・オフライン出力を検証しています。
詳細は [通常HTMLへの組み込み](LOCAL_DISTRIBUTION.md) を参照してください。

## 開発と検証

```sh
npm ci
npm run build
npm run test:mp3
```

Playwrightで公開APIと通常script版を実行し、生成物をFFmpeg／ffprobeで独立検査します。
既存WAVからの変換、AudioBuffer、整数／浮動小数点WAV、サンプルレート、左右音声の保持、
最終ブロック、進捗・中止・再試行、入力／容量エラー、サンプルのWAV/MP3切り替えを検証します。
FFmpegは開発テストだけに必要です。

圧縮エンジンは `@breezystack/lamejs` 1.2.7（LGPL-3.0）です。
本プロジェクト独自のAPI、WAV読取、Worker制御はMITです。
[第三者ライセンスと同梱ソース](../THIRD_PARTY_NOTICES.md)を参照してください。
