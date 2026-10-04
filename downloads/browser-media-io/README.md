# Browser Media I/O 0.2.0 リリース

[**リリースZIPをダウンロード**](https://github.com/cityedge/browser-media-i-o/raw/refs/heads/main/downloads/browser-media-io/browser-media-io-0.2.0.zip) ／ [SHA-256](SHA256SUMS)

2026-10-04（日本時間）に配布構成と文書を整備しました。ライブラリ本体は0.2.0のままです。
[導入ガイド](../../docs/GETTING_STARTED.md) ／ [変更履歴](../../CHANGELOG.md) ／ [API](../../docs/API.md) ／ [検証結果](../../docs/VALIDATION_0.2.md)

ZIPを展開すると `browser-media-io-0.2.0/` フォルダーができます。

| パス | 内容 |
|---|---|
| `README.md`、`CHANGELOG.md` | 案内と変更履歴 |
| `packages/browser-media-io-0.2.0.tgz` | 利用アプリにnpm installするパッケージ |
| `dist/` | ビルド済みES Modules、TypeScript型定義 |
| `dist/standalone/` | HTML用MP3の単独JSと動作サンプル |
| `src/`、`package-lock.json`、設定ファイル | ライブラリのソースと固定したビルド依存 |
| `docs/` | 導入・API・制限・ビルド手順・測定結果 |
| `examples/` | Canvas、動画、PCM、WebGL、Worker、MP3の利用例 |
| `tests/`、`scripts/`、`apps/studio/` | 再検証の仕組みと評価アプリFramecraft |
| `LICENSE.md`、`THIRD_PARTY_NOTICES.md`、`third_party/` | ライセンスと同梱MP3エンコーダーの対応ソース |
| `SHA256SUMS` | ZIP内部ファイルのハッシュ |

node_modules、Git情報、生成テスト動画、一時ファイル、過去の配布バイナリーは含めていません。
ZIPのままアプリを起動する形式ではありません。利用先プロジェクトで、同梱tgzをインストールします。

```sh
npm install --save-exact /path/to/browser-media-io-0.2.0/packages/browser-media-io-0.2.0.tgz mediabunny@1.61.0
# ネイティブAAC非対応環境にも対応する場合
npm install --save-exact @mediabunny/aac-encoder@1.61.0
```

[tgzだけをダウンロード](https://github.com/cityedge/browser-media-i-o/raw/refs/heads/main/downloads/browser-media-io/browser-media-io-0.2.0.tgz) することもできます。
Mediabunny 1.61.0はnpmが取得します。本体とAAC拡張で同じ基盤を共有するため、上記のとおりアプリ側にも完全固定してください。MP4側はVite等でアプリに組み込み、HTTPS／localhostで実行します。
MP3保存だけを通常HTMLに追加する場合は `dist/standalone/browser-mp3.js` を使用してください。
詳細は同梱の導入ガイドにあります。

## ハッシュの確認

このページのSHA256SUMSは配布ZIPとtgz、ZIP内部のSHA256SUMSは展開後の個別ファイルが対象です。
Linuxでは同じ場所に保存して `sha256sum -c SHA256SUMS`、macOSでは `shasum -a 256 -c SHA256SUMS` を実行できます。
ZIPだけをダウンロードした場合はtgz行の欠落表示を区別してください。
Windows PowerShellでは `Get-FileHash ./browser-media-io-0.2.0.zip -Algorithm SHA256` の結果を対応する行と比較します。

## ビルド・再配布

Node.js 22.12以降で、展開したルートから `npm ci` → `npm run build` を実行できます。
[再ビルド・再検証・ZIP作成](../../docs/BUILDING.md) の手順を同梱しています。
本体はMIT、Mediabunny／AAC拡張はMPL-2.0、同梱MP3エンコーダーはLGPL-3.0です。
依存の通知・対応ソース・再ビルド手順を保持してください。

この配布ファイルの作成はnpmレジストリへの公開ではありません。

## 今回の配布検証

ZIPを新規フォルダーへ展開し、npm ci、ビルド・型検査、Playwright 54件が成功しました。
同梱ソースから再作成したZIPはバイト単位で一致しています。既存0.2.0のJS・型定義30ファイルも同一です。
別アプリへのtgz導入ではMP4の30フレーム／48,000サンプルの入出力と、MP3出力・単独script版との一致を確認しました。
Linux Chromiumでの結果です。[検証記録](VERIFICATION.json) を参照してください。
