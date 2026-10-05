# ソースからのビルドと配布物の再作成

リリースZIPには、ビルド済みライブラリと、ソース・ロックファイル・テスト・評価アプリを含めています。
node_modules、生成テスト動画、テスト実行結果、一時ファイル、過去の配布物は含めません。

## ビルド

Node.js 22.12以降を用意し、ZIPを展開したルート、またはリポジトリのルートで実行します。

```sh
npm ci
npm run build
npm run typecheck
```

出力先は `dist/`、通常HTML用MP3は `dist/standalone/` です。
依存はインターネットからnpmが取得します。ビルドにはFFmpeg／Chromiumは不要です。
利用アプリへの導入には、あらかじめ同梱した `packages/browser-media-io-0.2.1.tgz` も使えます。
新たにインストール用パッケージを作る場合は `npm pack` を実行してください。

## テストと評価アプリ

FFmpeg／ffprobe 7.1以降（libx264・AAC・libmp3lame入り）とChromiumを用意します。

```sh
npx playwright install chromium
npm test
npm run app:dev
```

npm testはビルド、型検査、素材生成、Webの59件とFramecraftの6件を実行します。
Webテストは素材を生成してからViteを起動するため、初回展開時にも準備コマンドを追加する必要はありません。
Framecraftは同じ端末のブラウザでlocalhost:4174から利用できます。
詳しい条件・Windowsでのブラウザ指定は [評価レポート](VALIDATION_0.2.md) を参照してください。

```sh
node scripts/collect-validation.mjs # npm test直後の通常テスト結果を要約
npm run test:release                # 30分の出力と二動画の性能測定
```

測定JSONは既定でdocs/reports/v0.2へ保存されます。配布時の記録を残す場合は、環境変数MEDIA_REPORT_DIRで別の保存先を指定してください。
FFmpegやブラウザはライブラリの利用先アプリに同梱するものではありません。

## リリースZIP

開発用の `zip` コマンド（Info-ZIP）が別途必要です。Linux／macOSまたはWSL等で実行できます。
アプリに導入する人にはzipコマンドは不要です。

```sh
npm run package:release
```

ライブラリをクリーンビルドし、`downloads/browser-media-io/` に次を生成します。

- `browser-media-io-0.2.1.zip`：ビルド済み成果物と再ビルド用ソース一式。
- `browser-media-io-0.2.1.tgz`：npm install用。同一ファイルをZIP内packages/にも格納。
- `SHA256SUMS`、`browser-media-io-0.2.1.sha256`：配布ZIPとtgzのSHA-256。

過去のZIP・tgzは上書きしません。0.2.0のハッシュと検証記録はバージョン付きの別ファイルに保持しています。

ZIPは一つの `browser-media-io-0.2.1/` フォルダーに展開されます。ルートのSHA256SUMSには内部の各ファイルのハッシュがあります。
作成スクリプトは明示したファイル・ディレクトリだけを採用し、ビルドやテストの残骸を除外します。
Git情報やnode_modulesを配布しません。Markdownの相対リンクも検査します。
ファイル順、権限、ZIPの時刻を揃えて作成します。同じソース・依存・ツールでの再生成時に差を比較できます。
バージョンはpackage.jsonから読みます。リリースノートの日付やドキュメントの版表記は作成者が更新してください。

ZIPだけを作成し、GitHub Releaseの公開やGitタグの作成は自動で行いません。
公開する場合の添付ファイルはZIPとSHA256SUMSです。ZIPが本体、tgzはnpm利用者への単独配布にも使えます。

## 同梱MP3エンコーダーを差し替える

`third_party/lamejs/source.tar.gz` に対応する上流ソースとビルドファイル、同じディレクトリにGPLv3／LGPLv3全文があります。
エンコーダーは未改変です。上流ソースを展開し、そのpackage.json／pnpm-lock.yamlに従ってビルドしてください。
出来上がったローカルパッケージをこのソースプロジェクトにインストールし、`npm run build` を再実行すると、
MP3 Workerと通常script版に組み込まれます。差し替えに署名鍵は不要です。

本体のMITライセンスは依存エンコーダーのライセンスを置き換えません。
[第三者ライセンスと配布ソース](../THIRD_PARTY_NOTICES.md) を保って再配布してください。
