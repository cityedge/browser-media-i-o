# Browser Media I/O — 0.1.0

Webアプリに、メディアの **入力・情報取得・MP4/MP3出力** を追加するTypeScriptライブラリです。
ブラウザ内で処理し、画面録画やサーバー側の動画変換を必要としません。
字幕描画、スペアナ、動画編集、合成などは利用アプリで実装できます。

MP4関連の公開APIと制御処理は、Mediabunnyのコンテナ解析・格納／コーデック機能の上に実装しています。
MP3出力は独立したモジュールで、同梱のLAME系エンコーダーを使用します。

## できること

| API | 機能 |
|---|---|
| `probe(file)` | MP4/M4A・MP3・WAVのトラック、サイズ、コーデック、時間などを取得 |
| `openMedia(file)` | 必要な時刻の映像フレーム、必要区間のPCM音声を取得 |
| `decodeAudio(file)` | 音源を全デコードし、実サンプル数とAudioBufferを取得 |
| `renderMp4(options)` | 各時刻のCanvas描画と音声から、固定fpsのMP4を生成 |
| `createMp4Writer(options)` | アプリが用意したフレームとPCMを順に渡してMP4を生成 |
| `getCapabilities(options)` | 指定条件でのブラウザのエンコード対応を確認 |
| `wavToMp3(wav)` / `encodeMp3(audioBuffer)` | 独立した `/mp3` モジュールで、完成済み音声をMP3に変換 |

長さの情報源はメタデータ・パケット走査・デコード結果を区別します。
既定のprobeはパケットを走査します。音源の実際の長さは `decodeAudio` が返す
`sampleCount / sampleRate` から得られます。

映像出力はH.264、音声はAACが既定です。AAC非対応のブラウザでは、明示的に有効化する
オプションのWASM拡張を使えます。Opusは指定した場合にだけ使います。
音声なし出力、進捗、キャンセル、Blobの容量制限、直接ファイル保存用ストリームも利用できます。

詳細: [APIと動作契約](docs/API.md) ／ [音源＋Canvasの例](examples/canvas-with-audio.ts) ／ [動画入出力の例](examples/video-roundtrip.ts)

## WAV出力にMP3の選択肢を追加する

既存アプリのWAV保存直前に、変換を一つ追加できます。MP4機能の導入は不要です。

```ts
import { wavToMp3 } from 'browser-media-io/mp3';
const blob = format === 'mp3' ? await wavToMp3(wavBlob) : wavBlob;
```

AudioBufferから直接出力する `encodeMp3(audioBuffer)` もあります。
通常のHTMLへscriptタグで追加できる、エンコーダー同梱の約177 KBの単独JSも用意しています。
[配布ZIP・WAV/MP3切り替えサンプル](downloads/browser-mp3/README.md) ／ [APIと対応範囲](docs/MP3.md)

## 実際に使って評価する

このリポジトリには評価用アプリ **Framecraft** があります。
画像／MP4＋音源＋SRTからMP4を作り、プレビュー、音声の実測時間、キャンセル、出力結果を確認できます。
「サンプルを試す」で素材なしでも動作を試せます。

```sh
npm ci
npm run app:dev
```

同じ端末のChrome／Edgeで **http://localhost:4174** を開いてください。
アプリの利用にFFmpegは不要です。
[起動手順・評価結果・現在の制限](docs/FRAMECRAFT.md)をまとめています。

既存アプリへの組み込み例として、[SRT Tap TimerのMP4出力検証版・適用パッチ](integrations/srt-tap-timer/README.md)もあります。

## ビルド・アプリへの組み込み

Node.js 22.12以降を用意してください。このリポジトリはまだnpm公開していません。

```sh
npm ci
npm run build
npm pack
```

生成されたパッケージを自作アプリにインストールします。

```sh
npm install /path/to/browser-media-io-0.1.0.tgz
# ネイティブAAC非対応環境でもAAC出力したい場合のみ
npm install @mediabunny/aac-encoder@1.61.0
```

パッケージはES ModulesとTypeScriptの型定義を含みます。React等のフレームワークに依存しません。
開発・実行対象はHTTPSまたはlocalhostのデスクトップChrome／Edgeです。

```ts
import { decodeAudio, renderMp4 } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';

const audio = await decodeAudio(audioFile);
await enableAacFallback({ sampleRate: audio.sampleRate, channels: audio.channels });

const result = await renderMp4({
  width: 1280, height: 720, fps: 30, duration: audio.duration,
  audio: audio.buffer,
  onProgress: ({ fraction }) => console.log(fraction),
  renderFrame(ctx, time) {
    ctx.fillStyle = '#152333'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = 'white'; ctx.font = '48px sans-serif';
    ctx.fillText(`再生位置 ${time.toFixed(2)} 秒`, 80, 120);
  },
});
// result.blob が完成したMP4です。
```

ネイティブAACだけを使うアプリは `/aac` のimportと有効化を省略できます。
基本パッケージからAAC拡張を自動ロードすることはありません。

## テスト

FFmpeg／ffprobe（libx264、AAC、libmp3lameが必要）とChromiumを使用します。
FFmpegは素材生成と独立検証だけに使い、ライブラリの実行時には不要です。

```sh
npm ci
npx playwright install chromium
npm test
```

このクラウド環境にはFFmpegとChromiumがあるため、次のコマンドで実行できます。

```sh
npm --cache /tmp/codex-npm-cache ci
npm test
```

ブラウザは `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` の明示指定、Playwright管理ブラウザ、
既存 `/usr/bin/chromium` の順で選択し、実際のバージョンをレポートへ保存します。
FFmpeg／ffprobeのパスは `FFMPEG_PATH`／`FFPROBE_PATH` で指定できます。
LinuxでブラウザのOS依存が不足する場合は `npx playwright install --with-deps chromium` を実行してください。

**テストはビルド済みライブラリの公開APIを使用します。** `npm test` はメディア入出力16件、
MP3出力17件、本番ビルドしたアプリの操作テスト6件を実行します。メディア入出力では以下を検証します。

- 10秒・30fps・300フレームのH.264/AAC素材を毎回生成し、元の生成条件と照合。
- 全フレームの番号・順序・タイムスタンプと、左右音声の異なる時刻に入れた音を検査。
- 同じフレーム数でも途中のフレームを複製した出力を、検査器が拒否。
- メタデータ取得と全パケット走査、前後シーク、フレーム解放、範囲外の取得。
- 5.016秒と申告するMP3から、10秒・480,000サンプルの音声を取得。
- 音声区間のサンプル精度の切り出し。
- MP4の映像・音声を全デコードし、H.264＋AAC（WASM補完）とH.264＋Opusに再エンコード。
- CanvasとWAVからのMP4生成、Blob保存と実ファイルストリーム保存。
- 二つの動画を共通の時計で読み、30000/1001fpsで出力。
- 途中キャンセル、容量超過、書き込み失敗、引数エラー、所有権。
- AAC初期化中の中止で、未完了の書き込みが待ち続けず、再出力できること。

独立検査はFFmpeg／ffprobeで実行します。映像時刻の誤差上限は2µs、出力音声マーカーは5ms（入力素材検査は25ms）、
デコード後音声長は50msを初期基準としています。音声の遅延・パディングを含む許容値で、
すべての入力に対するサンプル単位の完全一致を保証するものではありません。

Linux版ChromiumのネイティブAACエンコードは非対応ですが、WASM拡張を使用する通常テストではAAC出力まで確認します。
ネイティブ実装だけを要求する次の専用チェックは、非対応環境では明確に失敗します。

```sh
TEST_NATIVE_AAC=1 npx playwright test --grep 'native AAC' --output=.cache/native-aac-results --reporter=list
```

```sh
npm run test:report    # HTMLレポート
npm run test:web:ui    # Playwright UI
npm run fixtures      # テスト素材のみ生成
npm run test:mp3      # MP3出力・WAV/MP3サンプルだけ検証
npm run package:mp3   # 単独JSの配布ZIPを生成（開発時のみzipコマンドが必要）
```

`test-results/` に出力動画・検査JSON・失敗時のトレース、`playwright-report/` にHTMLレポート、
`tests/fixtures/generated/` に生成素材と正解データを保存します。これらはGitに含めません。
Viteの起動・停止はPlaywrightが管理します。

## 初版の境界

動画全体の非圧縮展開は行いません。区間読み取り・フレーム解放・出力の処理待ち制御を使います。
全音源の `decodeAudio` とBlob出力は、それぞれ音声全体・完成ファイル分のメモリを使います。
長尺には `audioBlocks` とストリーム出力を利用してください。

初版はMP4/M4A、MP3、WAVを中心に検証しています。長時間4K、スマホ、Safari／Firefox、
あらゆる破損ファイル、可変fps素材の網羅的な検証は今後の範囲です。

本体コードはMITライセンスです。依存ライブラリは独自のライセンスを持ちます。
[第三者ライセンスと依存関係](THIRD_PARTY_NOTICES.md)を参照してください。
