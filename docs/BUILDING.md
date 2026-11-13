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
MP3対応ソースの展開にtarを使用します（Windows標準のtar.exeで動作）。
VBR/ABRを含むMP3はJavaScriptで構成し、ビルド時にもWASMコンパイラーは不要です。
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

npm testはWeb 90件・Framecraft 6件と映像コピーの統合試験を実行し、Viteの起動・終了を自動管理します。
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

映像コピーだけの試験は `npm run test:video-copy`、2時間素材の逐次出力は `npm run test:video-copy:long` です。
ビルド後の `node scripts/test-video-copy.mjs --https` は、ローカルHTTPSで実FileSystemWritableFileStreamへの保存も確認します。
HTTPS試験の一時証明書生成にはWindowsのPowerShell/.NETを使用し、証明書ストアは変更しません。
`VIDEO_COPY_BUNDLE_DIR` に展開した通常script版のルートを指定すると、その配布物を試験できます。
結果は `tests/tmp/video-copy/`、長尺は `tests/tmp/video-copy-long/` に保存します。
試験内容と対応範囲は [0.6.0検証記録](VALIDATION_0.6.0.md) を参照してください。

0.6.1では`test:video-copy`と`npm test`にSPSのgap許可／実際の不連続の回帰試験を含めています。
ビルド後の `node scripts/test-video-copy-zoom.mjs "入力MP4のパス"` は任意の実素材で、全映像コピーと元音声を0.5倍に加工した区間連結を検査します。
既定の区間は約81分の検証素材向けです。別の長さの素材にはスクリプト内の区間指定を調整してください。
`--short`は先頭・中間・末尾の短い保持区間で音声付き出力を検査します。実素材は読み取り専用で、生成物はtests/tmp/zoom-copy-*へ保存します。
素材本体・変換後メディア・詳細レポートは公開パッケージへ含めません。[0.6.1検証記録](VALIDATION_0.6.1.md)。

0.7.0では`npm test`と`test:video-copy`に`test-video-copy-container.mjs`を追加しています。
単独実行時は先にビルドと`node scripts/test-video-copy-gaps.mjs`を実行してください。
強行コピーのペイロード・PTS・省略／時間調整、警告後の設定変更／破損の停止、PCM同期、
file://の通常／強行切り替えとpublic Workerを確認します。結果は`tests/tmp/video-copy-container/`です。
[0.7.0検証記録](VALIDATION_0.7.0.md)を参照してください。
強行試験の`--https`はローカルHTTPSで実行します。実素材試験の`--container`は強行モードを選択し、別の結果フォルダーへ保存します。

## アプリ実装例

`npm run app:dev` でFramecraftをlocalhost:4174に起動できます。
これは組み込み例の開発用サーバーです。通常script版の利用アプリにサーバーを要求するものではありません。
ソースと用途は [Framecraft](FRAMECRAFT.md) を参照してください。
