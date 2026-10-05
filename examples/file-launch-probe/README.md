# ローカルHTML起動の開発用試作

クラウドの一時フォルダーにあった試作を、Gitから再生成できる形で保存しています。
正式なライブラリ配布形式や完成アプリではありません。ライブラリ本体・既存の65件テスト・Release ZIPは変更しません。

クラウドではIIFE形式への同梱ビルドまで確認しました。ブラウザの管理ポリシーにより
file://への遷移が `ERR_BLOCKED_BY_ADMINISTRATOR` で拒否されるため、直接起動の動作は未確認です。
HTTPでの成功をfile://の成功として扱わず、ブラウザの制限を緩めるフラグも使いません。

## 再生成

リポジトリのルートで実行します。Node.js 22.12以降が必要です。

```sh
npm ci
npm run build
node examples/file-launch-probe/build.mjs
```

出力は `.cache/file-launch-probe/` の `index.html`、`app.js`、`standalone.js` です。
そのindex.htmlをエクスプローラーから直接開きます。ブラウザに渡すコードは全て同梱し、CDNは使いません。
初回npm ciにはネット接続が必要です。ブラウザでの実行はネットから切り離した状態でも確認してください。

`app.js` は `/public`・AAC拡張・MP3をまとめた通常scriptです。`standalone.js` は既存の単独MP3版で、出力比較に使います。
AAC拡張を有効化しても、ブラウザがネイティブAACを提供する場合はそちらが選ばれます。結果のbackendを記録してください。

## 手動・自動試験

入力確認用のreference.mp4は `npm run fixtures` で生成します。FFmpeg／ffprobeが必要です。
選択するファイルは `tests/fixtures/generated/reference.mp4` です。
入出力チェックだけなら、このファイル選択なしでも実行できます。

```sh
npm run fixtures
npx playwright install chromium
node examples/file-launch-probe/check.mjs
```

既存のPlaywright設定やwebServerは使用しません。offlineなブラウザでfile://を開き、入力選択、MP4／PCM往復、
MP3生成、MP4／MP3のダウンロードを試します。実行対象ブラウザは `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で指定できます。
Windows Chrome／Edgeの指定例は [引き継ぎ書](../../docs/LOCAL_HANDOFF.md) にあります。
結果と保存ファイルは `test-results/file-launch-probe/` に生成します。成功はstatus=passedかつ終了コード0です。
管理ポリシーによる拒否も終了コード1で記録し、対応済みとは判定しません。

この試験は機能確認用です。画素値・長尺・多数回のキャンセル・各種コーデックの完全な検証にはなりません。
file://で動くことが確認できたら、[引き継ぎ書](../../docs/LOCAL_HANDOFF.md) に沿って本番用の配布形式へ整備してください。
配布物を作る際は、依存のライセンス・対応ソース・再ビルド手順も同梱します。
