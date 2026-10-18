# WAV出力にMP3の選択肢を追加する

完成済み音声を一括変換する小さなモジュールです。リアルタイム録音・再生は使いません。
MP4機能、Mediabunny、WebCodecs、AudioContext、サーバーでの変換は不要です。
MP3エンコーダーは同梱され、Worker内で処理します。変換中の外部通信はありません。
0.5.0からCBR・VBR・ABRに対応します。MP3用のWASMは追加せず、既存のlamejsをJavaScriptで拡張しています。

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

MP3専用の `browser-mp3-0.5.0.zip`、またはビルドで生成した `dist/standalone/` を使用します。
エンコーダーを含む `browser-mp3.js` と、WAV/MP3の切り替えを試せる `index.html` が入っています。
JavaScriptファイルは約187 KB（圧縮済みJS、gzip未適用）。実行時のnpmインストールやCDNは不要です。
MP3専用ZIPにはライセンス文書とソースの入手案内を含めています。
変更・再ビルド用ソースは、同じReleaseの `browser-media-io-sources-0.5.0.zip` に分離しています。
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
| `mode` | `'cbr'`（既定）／`'vbr'`／`'abr'` |
| `bitrate` | bit/s単位のCBR。通常は192000。32 kHz未満の入力は既定128000 |
| `vbrQuality` | VBR専用。整数0～9、0が最高品質、既定4 |
| `abrBitrate` | ABR専用で必須。目標平均bit/s。1000単位の整数。例: 137000 |
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

```ts
await encodeMp3(audio, { mode: 'cbr', bitrate: 192000 });
await encodeMp3(audio, { mode: 'vbr', vbrQuality: 2 });
await encodeMp3(audio, { mode: 'abr', abrBitrate: 192000 });
```

VBRは残っていたLAMEの旧RH方式を補完した実装です。現在のLAMEの既定方式（MTRH）と
同じ品質番号でも音質・サイズが一致するとは限りません。品質を指定し、フレームごとのビット数を選びます。
ABRは目標平均に向けて配分しますが、無音や単純な音声では目標を下回り、厳密な容量保証ではありません。
ABRの範囲は32 kHz以上が32～320 kbps、16～24 kHzが8～160 kbps、16 kHz未満が8～64 kbpsです。
VBR/ABRは入力サンプルレートを維持します。モードに合わないオプションの併用はINVALID_ARGUMENTで拒否します。
指定したモードからCBRへ黙って切り替える処理はありません。省略時のCBRは従来の動作を維持します。

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
- VBR/ABRにはフレーム数・総バイト数・シーク索引を持つXingヘッダーを付与します。
  ID3タグ・ジャケット・元のエンコーダー設定・ギャップレス再生用タグは付与しません。
  圧縮処理の遅延と末尾の余白が加わります。
  44.1/48 kHzでは合計約50 ms以内をテストで確認します。サンプル単位で元の長さと一致する仕様ではありません。

デスクトップChromiumとWindows Chrome/Edgeで検証しています。Firefox／Safari／モバイルは未検証です。
今回追加したVBR/ABRはWindows Chrome 155で回帰検証し、Chrome／Edge 155で配布ZIPからの出力も確認しました。
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
0.5.0では9種類のサンプルレートでVBR/ABRを独立デコードし、波形・フレーム構造を確認しています。
CBRの旧エンコーダーとのバイト一致、VBR品質・ABR目標値による出力の変化、Xingの時間・索引、
file://・オフライン・WASM無効化、30秒のステレオ音声、追加オプションと容量上限も検査します。
FFmpegは開発テストだけに必要です。

圧縮エンジンは `@breezystack/lamejs` 1.2.7の対応ソースを基にした改変版（LGPL-3.0）です。
`third_party/lamejs/extensions/` にVBR/ABR制御を置き、`scripts/prepare-lamejs.mjs` で
未使用経路の修正を適用してビルドします。C/C++コンパイラーやEmscriptenは不要です。
本プロジェクト独自のAPI、WAV読取、Worker制御はMITです。
[第三者ライセンスと同梱ソース](../THIRD_PARTY_NOTICES.md)を参照してください。
