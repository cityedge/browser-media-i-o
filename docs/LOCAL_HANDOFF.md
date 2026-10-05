# ローカルCodexへの引き継ぎ

更新: 2026-10-05（日本時間）。この文書とGitHubのmainを、クラウドでの会話・一時ファイルがなくても再開できる引き継ぎ元とします。
リポジトリ: https://github.com/cityedge/browser-media-i-o

## 最初に引き継ぐ目的

ユーザーが求めている配布・起動方法は **ZIPを展開し、ローカルのindex.htmlを直接開いて使うこと** です。
利用者にNode.js、npm、開発サーバーの起動を要求しません。ブラウザでの変換にはサーバー・CDNへの通信も要求しません。
ライブラリや利用アプリを開発・ビルドする側でNode.js等を使うことは構いません。

現状はnpm／ES ModulesとViteを中心に整備されており、この起動方法はまだ正式対応していません。
Viteで起動できること、localhostで検証に通ること、PWAや静的ホスティングに載せることは、今回の直接起動要件の完了条件ではありません。
移管後の最優先作業は、file://からの起動をローカルのChrome／Edgeで実測し、必要な配布形式とテストを整備することです。

## 現在の実装と配布状況

- ライブラリは0.2.1。実装基準コミットは `86c32fbfa48aa33c825c7f64e1a926600d1653ff`。
  その後のmainに、この引き継ぎ書とローカル起動の開発用試作を追加しています。
- 入力・情報取得・MP4出力、独立したMP3出力、連続フレーム取得、キャンセル、Worker用PCM入出力を実装済み。
- 0.2.0はユーザーがGitHub ReleasesへZIPをアップロード済みと申告しています。
  0.2.1は `downloads/browser-media-io/` にZIP・tgz・ハッシュを保存し、mainへプッシュ済みです。
  0.2.1のGitHub Release公開は確認していません。新しいRelease公開済みと推測しないでください。
- 0.2.0／0.2.1の既存ZIPは今回の引き継ぎ用変更で再生成していません。引き継ぎには最新mainをcloneしてください。
- npmレジストリには公開していません。利用先アプリはtgz、またはビルドしたパッケージから導入します。

| 参照先 | 内容 |
|---|---|
| [API](API.md) | 入出力・所有権・時刻境界・キャンセルの現在の契約 |
| [導入ガイド](GETTING_STARTED.md) | 現行のnpm版導入方法とAACの依存条件 |
| [ビルド手順](BUILDING.md) | 開発・試験・ZIP生成 |
| [0.2.1の評価](VALIDATION_0.2.1.md) | 最新65件の検証結果と限界 |
| [0.2.0の評価](VALIDATION_0.2.md) | 従来APIの30分出力・WebGL・性能記録 |
| [後続計画](IMPLEMENTATION_PLAN.md) | 元の設計とリサンプリング等の候補。現在はfile://対応を優先 |
| [ローカル起動試作](../examples/file-launch-probe/README.md) | 直前の試作のソース・生成・実行手順 |

## 二つの入力APIは両方残す

ユーザーの決定により、内部依存する既存APIと、公開APIだけを使う追加APIを併存させています。

```ts
import { openMedia as strictOpen } from 'browser-media-io';
import { openMedia as publicOpen } from 'browser-media-io/public';
```

両方とも同じ機能・型・引数・フレーム区間・所有権を提供します。違いは読み取り終了の保証です。

- 従来API: `await reader.return()` は旧デコーダーのcloseまで待ちます。
  `src/decoder-session.ts` がMediabunny 1.61.0の `_createDecoder`／`_createPacketSink` に接続しています。
- 公開API版: ラッパーの進行中next・未返却結果の破棄・排他解除まで待ち、入力を再利用できます。
  基盤の背景処理の終了は待ちません。旧処理が一時的に重なる可能性は契約として許容しています。
  `/public` のimportグラフには上記の内部接続アダプターが入りません。
- ルートの `openMediaPublic` も公開API版を呼びますが、ルートのimportグラフには従来アダプターが存在します。
  内部接続コードの読み込み自体を避けたいアプリは `/public` に統一します。
- 実メモリのGC完了や、固定時間内のキャンセルはどちらも保証しません。
- 公開APIを使うと資源が永久に残るという不具合は確認していません。
  0.2.1の反復試験では両APIとも追跡したデコーダーが解放されました。全環境への保証ではありません。

パッケージ全体は両APIが共存するため、Mediabunny 1.61.0を完全固定しています。
AAC拡張も1.61.0です。拡張だけ別のMediabunnyを参照すると登録先がずれてAACがUNSUPPORTEDになるケースを確認しています。
依存を更新する場合は、両APIの反復中止・Worker・AACを再検証してください。
Mediabunnyをコピーして独自保守する案も話しましたが、実施していません。現状の依存パッケージ本体は未改変です。

## コードの入口

| ファイル | 役割 |
|---|---|
| `src/index.ts`、`src/input.ts` | 従来APIの入口と終了保証の選択 |
| `src/public.ts` | 内部接続コードを読み込まない入口 |
| `src/input-core.ts` | 両API共通の入力・時刻判定・所有権・PCM処理 |
| `src/public-decoder-session.ts` | 公開iterator.returnだけを使う終了処理 |
| `src/decoder-session.ts` | 従来APIだけが使う、固定版への内部接続 |
| `src/reader.ts` | キャンセル、結果破棄、排他解除の管理 |
| `src/output.ts` | MP4 writerと高水準renderMp4 |
| `src/aac.ts`、`src/aac-state.ts` | AAC拡張の明示的有効化と音声遅延補正 |
| `src/mp3.ts`、`src/mp3/` | WAV／PCMからのMP3出力とWorker |
| `apps/studio/` | 評価アプリFramecraft。現在はViteで起動 |
| `tests/web/public.spec.ts`、`tests/web/streams.spec.ts` | 入口分離と両APIの読み取り回帰試験 |

編集タイムライン、合成式、字幕描画、音声ミックス、プレイヤーの同期判断は引き続き利用アプリの責務です。
ライブラリへ特定の編集アプリの仕様を追加しない方針です。

## ローカル環境で最初に実行すること

開発者用にGit、Node.js 22.12以降、npmを用意します。通常のテストにはFFmpeg／ffprobe 7.1以降
（libx264・AAC・libmp3lame入り）とChromium／Chrome／Edgeが必要です。

```sh
git clone https://github.com/cityedge/browser-media-i-o.git
cd browser-media-i-o
npm ci
npm run build
npm run typecheck
npx playwright install chromium
npm test
```

FFmpeg／ffprobeはPATHへ追加するか、`FFMPEG_PATH`／`FFPROBE_PATH` に実行ファイルのパスを設定します。
通常のnpm testは素材生成・Vite起動・Playwright検証・サーバー停止を自動で行います。
このサーバーは開発テスト用で、今回目指す利用者の起動手順ではありません。

Windows PowerShellでインストール済みChromeを使う例:

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
$env:MEDIA_REPORT_DIR = 'docs/reports/local-windows-chrome'
node scripts/collect-validation.mjs
```

Edgeの場合は実際のインストール先を指定します（例: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）。
環境変数を解除してPlaywright管理Chromiumへ戻す場合は `Remove-Item Env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を使います。
既存の `docs/reports/v0.2` と `v0.2.1` は過去の測定証拠として残し、ローカルの結果は別フォルダーへ保存してください。

## file://試験を阻んだものと試作の再現

クラウドのChromium 151.0.7922.173では、ローカルindex.htmlへのpage.gotoが次のエラーになりました。

```text
net::ERR_BLOCKED_BY_ADMINISTRATOR at file:///…/index.html
```

管理設定 `/etc/chromium/policies/managed/urls.json` はURLBlocklistが `*` で、許可リストには
HTTP／HTTPS等があり、file://は含まれていませんでした。ページ自体が読み込まれないため、
この結果からWebCodecs・AAC・Workerがfile://で動くかどうかは判断できません。
管理ポリシーを変更したり、アクセス制限を緩める起動フラグで回避したりしていません。

直前の試作は、公開API版・AAC拡張・MP3をesbuildで通常script（IIFE）へ同梱したものです。
元のクラウドの.cacheは不要です。このmainに保存したソースから次の手順で再生成できます。

```sh
npm run build
npm run fixtures
node examples/file-launch-probe/build.mjs
node examples/file-launch-probe/check.mjs
```

手動では `.cache/file-launch-probe/index.html` をエクスプローラーから直接開きます。
自動試験もHTTPサーバーを起動せず、offlineのブラウザでfile://へ遷移します。
Chrome／Edgeの選択には上記の `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` が使えます。
結果は `test-results/file-launch-probe/result.json`。管理ポリシーによる拒否も成功・skipに変換せず記録します。
ChromeとEdgeの試験結果は、次の実行で上書きされる前に別フォルダーへ退避してください。

同梱ビルド成功は確認済みです。[クラウドでの試験記録](reports/file-launch/cloud-blocked.json) も保存しています。
file://での入出力・保存・オフライン実行は未確認です。
詳細は [試作README](../examples/file-launch-probe/README.md) を参照してください。

## 移管後の作業順と完成条件

1. 既存の65件テストをローカルで実行し、ブラウザ／OS／AAC backendと結果を保存する。
2. 上記試作をChrome／Edgeで直接開き、File選択・MP4読取・音声付きMP4出力・MP3出力・保存を検証する。
   失敗した場合はページ読込、secure context、Worker、WASM、コーデックのどこで止まるかを切り分ける。
3. 正式な通常script版の入口・グローバル名・同梱範囲を設計し、既存npm版と両入力APIを維持したまま配布物を作る。
4. 実際のindex.htmlから起動するPlaywrightテストを整備する。HTTP経由への置換や、セキュリティ制限解除を前提にしない。
5. 配布ZIP内のindex.htmlを直接開いて、ネット接続なしでMP4／MP3を保存できることを確認する。
   初回起動もCDNや追加ダウンロードへ依存しないこと、ファイル名に日本語・空白を含むパスでも動くことを確認する。
6. 既存の通常テストも維持し、対応ブラウザ・制限・手順・ライセンスを文書化して新しい版として配布する。

WindowsのネイティブAACが使えた場合、その結果をWASM経路の検証済みとは扱わないでください。
既存の直接ファイルストリーム保存と、Blobからのダウンロードでは使うブラウザAPIが異なります。
file://で使える保存方法を確認してから、長尺やストリーム出力の対応範囲を決めてください。

Mediabunny／AAC拡張はMPL-2.0、MP3エンコーダーはLGPL-3.0、本ライブラリ独自部分はMITです。
新しい同梱配布では [第三者通知](../THIRD_PARTY_NOTICES.md)、各ライセンス、該当するソースの入手手段・再ビルド手順を整備します。
未改変の依存でも、単一JSへ同梱しただけで通知やソース提供の条件がなくなるわけではありません。

`npm run package:release` にはInfo-ZIPのzipコマンドが必要です。WindowsではWSL等を使うか、
新しい配布方式に合わせて作成スクリプトを整備してください。既存ReleaseのZIPを同名で上書きして公開し直さないでください。

## GitHubだけでは渡らないもの

node_modules、dist、生成動画、test-results、playwright-report、.cache、起動中プロセス、
クラウドの設定下書き、会話履歴は移管されません。必要なファイルは上記コマンドで再生成します。
製品コードと検証用素材の生成スクリプトに、クラウド固有のシークレットは不要です。
ローカルからのpush認証やCodexとリポジトリの接続は、ローカル側の通常の設定を使います。

新しいCodexセッションには、次のように伝えれば再開できます。

> docs/LOCAL_HANDOFF.mdを読んで、このリポジトリの開発を引き継いでください。
> 最優先は、利用者がサーバーやNode.jsを起動せず、ローカルのindex.htmlを直接開いてMP4・MP3入出力できる配布形式です。
> 既存APIと/publicの両方を維持し、まずローカルChrome／Edgeでfile://の試作を検証してください。
