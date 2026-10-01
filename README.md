# Browser Media I/O

ブラウザ内でのメディア入力・情報取得・MP4出力ライブラリに向けた開発リポジトリです。
現在は **Playwrightによるテスト基盤** を実装しています。ライブラリ本体・公開APIはまだありません。

JIZURAのコードは使用していません。テスト用の入出力アダプターにはMediabunnyを使用しています。
このアダプターの成功は将来の独自ライブラリの成功を意味しません。本体を実装したら、同じテストに接続して検証します。

## 実行

必要なもの:

- Node.js 22.12以降、npm。
- FFmpeg／ffprobe。素材生成には `libx264`、`aac`、`libmp3lame` エンコーダーが必要です。
- Chromium系ブラウザ。H.264エンコード、AACデコード、Opusエンコードが基本テストの前提です。

```sh
npm ci
npx playwright install chromium
npm test
```

Linuxでブラウザ実行に必要なOSライブラリが不足する場合は、管理権限のある環境で
`npx playwright install --with-deps chromium` を実行してください。

ブラウザは、環境変数 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` の指定、Playwrightが管理するブラウザ、
既存の `/usr/bin/chromium` の順で選びます。既存ブラウザを使う場合は実行時にパスを表示し、
実際のブラウザバージョンとコーデック対応をレポートに記録します。

```sh
# このクラウド環境ではChromiumとFFmpegがインストール済みです。
# npmキャッシュも書き込み可能な場所に置きます。
npm --cache /tmp/codex-npm-cache ci
npm test

# 使用するブラウザを明示する場合（POSIXシェル）
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test
```

FFmpegの場所は `FFMPEG_PATH`、ffprobeの場所は `FFPROBE_PATH` で指定できます。
ブラウザへの入力・出力処理にサーバー側のFFmpegは使いません。
FFmpegは素材生成と独立した検査のためだけに使います。

## 自動テスト

毎回、10秒・320×180・30fps・300フレームのH.264/AAC素材を生成します。
各フレームは0〜299を示す二進数の模様を持ち、音声は48kHz・2ch、
左に1/4/8秒、右に2/5/9秒の短い音を持ちます。入力映像にはBフレームと複数のキーフレームがあります。
生成条件から作る `manifest.json` が正解です。誤ったメタデータを正解にはしません。

基本テストは7件です。

1. ブラウザのコーデック対応を取得し、記録する。
2. 生成した素材をFFmpeg／ffprobeで検証する。
3. フレーム数が同じでも、途中の1枚を複製した壊れた出力を検査器が拒否する。
4. MP4の情報取得と、前後に移動する指定時刻のフレーム取得を確認する。
5. Xingヘッダーのフレーム数を半分にしたMP3で、デコード後のサンプル数と音声の位置を確認する。
6. 映像を全フレーム再エンコードし、AAC音声は圧縮データのまま保持してMP4を作る。
7. 映像と音声をデコードし、H.264＋Opusに再エンコードしてMP4を作る。

6はAACエンコードのテストではありません。7はブラウザ内の音声エンコードを含みますが、
H.264＋AAC出力とは別のテストです。Opus入りMP4の再生互換性も、AAC入りMP4とは異なります。

出力をFFmpegで再デコードし、300枚すべての識別番号・順序を照合します。
映像タイムスタンプの誤差上限は2µs、音声マーカーの開始時刻は25ms、
デコード後の音声長は50msです。後者二つは圧縮音声の遅延・パディングを考慮した
**基盤検証用の許容値**であり、ライブラリの最終的な精度保証ではありません。

音声ヘッダーのテストでは、申告時間と生成元の時間が実際に食い違うことも検査します。
この素材はブラウザが扱える一例です。あらゆる破損音源の復元を保証するものではありません。

### AAC再エンコードの専用チェック

```sh
TEST_NATIVE_AAC=1 npx playwright test --grep 'native AAC' --output=test-results/native-aac --reporter=list
```

このチェックはAACエンコーダーがなければ **失敗** します。自動スキップや別コーデックへの置換はしません。
初期検証に使用したLinux版Chromium 151ではAACデコードは利用できますが、AACエンコードは非対応でした。
AACエンコードの対応環境、または将来採用する明示的な代替実装で、別途検証する必要があります。

## 結果とデバッグ

```sh
npm run test:report
npm run test:web:ui
npm run fixtures
```

- `playwright-report/`: HTMLレポート。
- `test-results/results.json`: 実行結果、ブラウザ情報、検査結果。
- `test-results/`: 出力MP4、失敗時のトレース・スクリーンショット。
- `tests/fixtures/generated/`: 今回生成した素材と正解データ。

テスト起動時にViteをループバックアドレスで起動し、終了時にPlaywrightが停止します。
生成素材・レポート・依存パッケージはGitに含めません。

## 本体への接続

`tests/web/harness/main.ts` がテスト専用アダプターです。
将来の本体実装に `capabilities`、`inspect`、`decodeAudio`、`roundTrip` の呼び出しを接続します。
これは公開APIの仕様確定ではなく、テストと実装の境界です。

Mediabunnyは現時点では開発依存のみ（MPL-2.0）で、本体での採用は未決定です。
FFmpeg側の正解データ・検査器を独立させ、ブラウザ側と同じ誤りで成功しないようにしています。

複数動画の合成、長尺でのメモリ上限、キャンセル、直接ファイル保存、可変フレームレート、
スマホ・Safari・Firefoxの検証は、本体実装とともに追加する段階です。
