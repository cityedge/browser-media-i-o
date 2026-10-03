# Browser Media I/O 0.2.0 配布パッケージ

[パッケージをダウンロード](https://github.com/cityedge/codex_work_01/raw/refs/heads/main/downloads/browser-media-io/browser-media-io-0.2.0.tgz) ／ [SHA-256](SHA256SUMS)

ダウンロードしたファイルを、利用アプリのプロジェクトでインストールします。

```sh
npm install ./browser-media-io-0.2.0.tgz
# ネイティブAAC非対応環境にも対応する場合
npm install @mediabunny/aac-encoder@1.61.0
```

ES Modules／TypeScript型定義、ソース、利用例、仕様、ライセンスを含みます。
Mediabunny 1.61.0はnpmが依存としてインストールします。実行環境はHTTPSまたはlocalhostのWebブラウザです。

0.2の追加機能は連続映像取得、読み取り単位の中止、Worker用PCM入出力、回転・反転の情報です。
[API](../../docs/API.md) ／ [検証結果・Windowsでの手順](../../docs/VALIDATION_0.2.md) ／ [二動画のWorker出力例](../../examples/worker-export.ts)

ソースから再構築する場合はリポジトリのルートで `npm ci` → `npm pack` を実行してください。
このファイルはnpmレジストリへの公開ではありません。既存の単独MP3モジュール配布は [こちら](../browser-mp3/README.md) です。
