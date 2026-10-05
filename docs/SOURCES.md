# 対応ソースとエンコーダーの再ビルド

通常script版の組み込み用ZIPと、変更・再ビルド用ソースを分離しています。
実行時にはソースZIPは不要です。再配布時は通知・ライセンスと対応ソースを入手できる案内を保持してください。

[GitHub Releases](https://github.com/cityedge/browser-media-i-o/releases)でバイナリと同じ版の
`browser-media-io-sources-<version>.zip` を取得してください。
公開前の生成物は、リポジトリで `npm run package:sources` を実行すると作れます。

| 構成要素 | ソース |
|---|---|
| Browser Media I/O（MIT） | 対応ソースZIPのsrc/、scripts/、package-lock.json。またはこのリポジトリ |
| Mediabunny / AAC拡張 1.61.0（MPL-2.0） | 対応ソースZIPのthird_party/mediabunny-1.61.0.tar.gz |
| LAME系MP3エンコーダー 1.2.7（LGPL-3.0） | third_party/lamejs/source.tar.gz、COPYING、COPYING.LESSER |
| AAC WASM内のFFmpeg | 上流AAC拡張のビルド手順とFFmpeg上流ソース |

Mediabunny/AACの[固定版上流ソース](https://github.com/Vanilagy/mediabunny/tree/v1.61.0)には
shared、拡張パッケージ、ビルドスクリプト、上流の生成済みWASMが含まれます。
取得元とSHA-256は対応ソースZIPのthird_party/SOURCES.jsonに記録します。
FFmpegの[ソース](https://github.com/FFmpeg/FFmpeg)と、
[AAC WASMビルド手順](https://github.com/Vanilagy/mediabunny/blob/v1.61.0/packages/aac-encoder/README.md)も参照してください。
同梱WASMは上流パッケージの未改変バイナリです。上流の手順にFFmpegの厳密なリビジョン指定がないため、
WASMをソースから再生成した場合のバイト単位一致は検証していません。

## 本体の再ビルド

対応ソースZIPを展開したルートで、Node.js 22.12以降を使用します。

```sh
npm ci
npm run build
```

dist/browser/が通常script版、dist/standalone/がMP3専用版です。
ライブラリJSを利用アプリ側のファイルと置き換えてください。署名鍵は不要です。

## 依存の変更・再結合

1. 対応する上流ソースを展開し、変更します。
2. 上流のpackage.jsonやREADMEに従ってパッケージをビルドします。
   MediabunnyのビルドスクリプトはBashを使用します。AACのWASM再生成にはEmscriptenとFFmpegが必要です。
3. 本体のソースルートで変更後のローカルパッケージをインストールします。
4. npm run buildでJSと内蔵Workerを再生成します。

MediabunnyとAAC拡張の参照先は揃えてください。別のMediabunnyインスタンスにAACを登録すると利用できません。
MP3だけを変更する場合はthird_party/lamejs/source.tar.gz内の上流ビルド手順に従い、
出来上がったローカルパッケージを本体へインストールして再ビルドします。

本体のMITライセンスは依存ライブラリのライセンスを置き換えません。
通常script版ZIPのlicenses/にはMPL-2.0、GPLv3、LGPLv3、FFmpegのLGPLv2.1全文を含めています。
