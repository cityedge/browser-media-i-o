# Browser Media I/O

WebアプリにMP4・MP3・WAVの読み取り、映像フレーム／PCMの取得、MP4・MP3の出力を追加するJavaScript / TypeScriptライブラリです。
変換はブラウザ内で行います。編集UI、描画、音声ミックス、再生同期は利用アプリが担当します。

**[通常HTMLに組み込む](docs/LOCAL_DISTRIBUTION.md)** · [npm版の導入](docs/GETTING_STARTED.md) · [API](docs/API.md) · [変更履歴](CHANGELOG.md)

## ローカルサーバーなしで使う

0.3.0の通常script版は、**このライブラリを使うアプリ自身のindex.htmlを直接開く**構成に対応します。
利用アプリのフォルダーにJSを置き、通常のscriptタグで読み込みます。

```html
<script src="./lib/browser-media-io.js"></script>
<script>
  async function inspect(file) {
    const input = await BrowserMediaIO.openMedia(file);
    try { return await input.probe(); }
    finally { input.close(); }
  }
</script>
```

AACのWASMとMP3 Workerも同梱済みです。利用時にNode.js・ローカルサーバー・CDNは不要です。
素材はファイル選択で得たFile/Blobを渡します。
アプリ自身に外部ES Modulesやローカルファイルへのfetchがある場合は、その部分にもfile://対応が必要です。

| 導入方法 | 利用するもの |
|---|---|
| 通常HTML・file://起動 | `browser-media-io-browser-0.4.0.zip` のJS。ビルド時は `dist/browser/` |
| npm / バンドラー | `browser-media-io-0.4.0.tgz`。ES Modules・型定義を含む |
| MP3出力だけを追加 | `browser-mp3-0.4.0.zip` の `browser-mp3.js` |
| 変更・再ビルド | このリポジトリ、または対応する `browser-media-io-sources-0.4.0.zip` |

[公開済み配布物はGitHub Releases](https://github.com/cityedge/browser-media-i-o/releases)にあります。
上表は0.4.0の生成物名です。未公開の版は下記コマンドで生成してください。

MP4映像はVBR・CBR・CQPとエンコーダー優先を指定でき、出力結果から実測平均映像ビットレートを取得できます。
設定例と制約は[映像のレート制御](docs/API.md#映像のレート制御040以降)を参照してください。
従来の[0.2.1](https://github.com/cityedge/browser-media-i-o/releases/tag/v0.2.1)と
[0.2.0](https://github.com/cityedge/browser-media-i-o/releases/tag/v0.2.0)の配布物は各Releaseから取得できます。
npmレジストリには公開していません。

## 主なAPI

| API | 用途 |
|---|---|
| `probe(file)` | トラック、コーデック、サイズ、時刻・長さの情報 |
| `openMedia(file)` | シーク、連続フレーム、時刻付きPCM、キャンセル |
| `decodeAudio(file)` | 音声の全デコードと実サンプル数の取得 |
| `renderMp4(options)` | Canvas描画と音声から固定fpsのMP4を生成 |
| `createMp4Writer(options)` | 映像・PCMを逐次渡してMP4を生成 |
| `enableAacFallback(options)` | 必要時に同梱／追加インストールしたAAC拡張を有効化 |
| `wavToMp3(wav)` / `encodeMp3(audio)` | 完成済み音声をMP3に変換 |

通常script版の `BrowserMediaIO` は従来の終了保証を使います。
内部デコーダーへの接続コードを読み込まない場合は、別JSの `BrowserMediaIOPublic` を選んでください。
npm版ではそれぞれ `browser-media-io` と `browser-media-io/public` です。
両方とも同じ入力機能を提供しますが、キャンセル後の終了保証が異なります。[API契約](docs/API.md)を参照してください。

## ビルド

開発者はNode.js 22.12以降を使います。利用アプリのエンドユーザーには不要です。

```sh
npm ci
npm run build
npm run package:browser   # 通常script版の軽量ZIP
npm run package:release   # npm・MP3・対応ソースを含むRelease用ファイル一式
```

生成物は `dist/` と `output/releases/` に出力します。
大きな依存ソースは対応ソースZIPだけに含め、組み込み用ZIPやGitの通常ツリーには含めません。
[詳しいビルド・配布手順](docs/BUILDING.md)を参照してください。

## 利用例とテスト

- [通常script版の例](examples/local/)：ビルド後の `dist/browser/examples/local/index.html` を直接開けます。
- [Canvas＋音声](examples/canvas-with-audio.ts)、[動画の再出力](examples/video-roundtrip.ts)、[公開APIの読込](examples/public-input.ts)。
- [Worker＋PCM](examples/worker-export.ts)、[WebGL](examples/webgl-frame.ts)、[WAV保存にMP3を追加](docs/MP3.md)。
- [Framecraft](docs/FRAMECRAFT.md)：画像・動画・音声・字幕を組み合わせるアプリ実装例。Viteで動作します。

```sh
npm test                 # 型検査・既存の入出力59件・アプリ6件
npm run test:local       # 実際の軽量ZIPを展開し、file://・オフラインで検証
npm run check:distribution # 公開ファイル・文書リンク・npm収録範囲を検査
```

テストにはPlaywrightとFFmpeg/ffprobeが必要です。[環境設定](docs/BUILDING.md) /
[0.4.0の検証範囲](docs/VALIDATION_0.4.0.md) /
[0.3.0の検証範囲](docs/VALIDATION_0.3.0.md) /
[0.2.1のAPI検証](docs/VALIDATION_0.2.1.md) /
[長尺・性能検証](docs/VALIDATION_0.2.md)。

## 対応範囲

デスクトップChrome / Edgeを中心に検証しています。Safari・Firefox・モバイルは未検証です。
利用可能なコーデックはOS・ブラウザ・設定に依存します。
file://で確認した保存方法はBlobダウンロードです。長尺file://出力と直接ファイルストリーム保存は未検証です。
サンプル画面の60秒・128 MiBという上限はサンプル固有で、ライブラリ全体の固定上限ではありません。

本体はMIT。依存はMPL-2.0やLGPLなどの別ライセンスです。
[第三者通知](THIRD_PARTY_NOTICES.md)と[対応ソース・再ビルド方法](docs/SOURCES.md)を確認してください。
