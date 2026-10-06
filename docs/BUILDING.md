# ビルド・テスト・配布物の生成

## ビルド

Node.js 22.12以降を用意し、リポジトリまたは対応ソースZIPのルートで実行します。

```sh
npm ci
npm run build
npm run typecheck
```

| 出力 | 内容 |
|---|---|
| dist/*.js, *.d.ts | npm / ES Modules版 |
| dist/browser/ | 通常script版、通知、ライセンス、任意のサンプル |
| dist/standalone/ | MP3専用の通常script版とサンプル |

依存のインストールはネット接続を使用します。ビルドにはFFmpegやブラウザは不要です。
利用アプリのエンドユーザーはビルドを行う必要がありません。

## 配布物

```sh
npm run package:browser  # 組み込み用JS + ライセンス + 任意サンプル
npm run package:mp3      # MP3専用JS + ライセンス + 対応ソースの入手案内
npm run package:sources  # 本体と依存の対応ソース
npm run package:release  # 上記すべて + npm用tgz + SHA256SUMS
```

すべて `output/releases/` に生成します。通常script版と対応ソースZIPは分離しています。
package:localはpackage:browserの互換エイリアスです。
WindowsではPowerShell 7、Linux/macOSではzip/unzipを使用します。WSLは不要です。
対応ソースZIPの初回生成時だけ、固定版Mediabunnyの上流アーカイブ等を公式GitHubから取得し、固定SHA-256で照合します。
キャッシュは `output/third-party/`。HTML実行時には取得しません。

Releaseには同じ版の組み込み用ZIP・対応ソースZIP・tgz・SHA256SUMSを添付してください。
生成コマンドはGitHubへのアップロード・タグ作成を行いません。
旧配布物はGitHub Releasesから取得でき、生成物をGitのソースツリーへコミットする必要はありません。
変更・再結合方法は [対応ソース](SOURCES.md) を参照してください。

## テスト

FFmpeg/ffprobe 7.1以降（libx264・AAC・libmp3lame）とPlaywrightのブラウザが必要です。
FFMPEG_PATH / FFPROBE_PATHで実行ファイルを指定できます。

```sh
npx playwright install chromium
npm test
npm run test:local
npm run check:distribution
```

npm testはWeb 68件・Framecraft 6件を実行し、Viteの起動・終了を自動管理します。
VBR/CBR/CQPの対応確認、実際のエンコーダー設定、FFprobeによる映像パケットサイズの独立検査を含みます。
test:localは実際の軽量ZIPを新しい日本語・空白パスへ展開し、サーバーなし・オフラインでfile://へ遷移します。
ネイティブAACとWASM AACを分けて試験します。両経路を確認するためネイティブAAC対応のWindows Chrome/Edgeを使用してください。
WASM経路はテスト内でAACの能力応答だけをfalseにして実行します。
check:distributionは文書リンク、公開対象の構成、npmパッケージの収録範囲を検査します。

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
npm run test:local
# Edgeを使う場合は実際のmsedge.exeのパスに変更
```

通常テストの成果物はtest-results/、file://の成果物はtests/tmp/local-<browser>/に保存します。
集計は `node scripts/collect-validation.mjs` でoutput/validation/に保存できます。
MEDIA_REPORT_DIRで変更可能です。既存の版別検証記録を上書きしない場所を指定してください。
30分出力・性能測定は `npm run test:release` で別途実行します。

## アプリ実装例

`npm run app:dev` でFramecraftをlocalhost:4174に起動できます。
これは組み込み例の開発用サーバーです。通常script版の利用アプリにサーバーを要求するものではありません。
ソースと用途は [Framecraft](FRAMECRAFT.md) を参照してください。
