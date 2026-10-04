# Browser MP3 — WAV出力への追加用モジュール

[配布ZIPをダウンロード](https://github.com/cityedge/browser-media-i-o/raw/refs/heads/main/downloads/browser-mp3/browser-mp3-0.1.0.zip)

完成済みのWAVをMP3に変換するモジュールと、WAV/MP3を選んで保存できるサンプルです。
JavaScript本体は約177 KB。エンコーダーを含み、サーバー変換・録音・再生・CDN接続は不要です。

## 既存アプリへの追加

ZIPから `browser-mp3.js` を取り出し、HTMLの近くに配置します。

```html
<script src="browser-mp3.js"></script>
```

既存のWAV保存処理で、保存直前のBlobを必要に応じて変換します。

```js
const wavBlob = createWav(); // ここはアプリがすでに持っている処理
const blob = format === 'mp3'
  ? await BrowserMp3.wavToMp3(wavBlob)
  : wavBlob;
// blob を既存の保存処理に渡す。拡張子は format に合わせて .mp3 / .wav にする。
```

AudioBufferがある場合は `await BrowserMp3.encodeMp3(audioBuffer)` でも出力できます。
既定は192 kbps CBR（32 kHz未満の入力は128 kbps）。

## サンプルを試す

ZIPを展開したフォルダーで、次のコマンドを実行します。

```sh
python3 -m http.server 4181
# Windowsでは py -m http.server 4181
```

同じ端末のChrome／Edgeで `http://localhost:4181/index.html` を開きます。
ファイル未選択なら3秒のサンプル音を生成します。WAVを選択して変換することもできます。
サーバーはファイル配信だけに使い、音声のアップロードや変換は行いません。
既存のWebアプリに組み込む場合、このPythonコマンドは不要です。

## 同梱物と仕様

- `browser-mp3.js`: 通常のscriptタグ用モジュール。
- `index.html`: WAV/MP3切り替えの動作サンプル。
- `source/`: 独自ラッパーのソース、ビルド設定と手順。`source/docs/MP3.md` にAPIの詳細。
- `third_party/`: 同梱エンコーダーの対応するソースとライセンス。

モノラル／ステレオ、8～48 kHzのMP3対応サンプルレートを受け付けます。
一般的な整数PCMおよび浮動小数点のWAVに対応します。96 kHzなどは先にリサンプリングが必要です。
全体をメモリ上で変換する用途向けで、WAV入力・MP3出力の既定上限は各256 MiBです。
MP3の先頭遅延・末尾余白を取り除くギャップレス用タグは初版では付けません。
44.1/48 kHzでの長さの増分は約50 ms以内を検証しています。

ChromiumでPlaywrightとFFmpeg／ffprobeによる検証を実施しています。
MP3関連17件と既存機能22件、合計39件が成功しました（スキップ・再試行なし）。
10秒のステレオWAVは240,768バイトのMP3になり、デコード後は10.032秒でした。
左右の音声マーカー、WAVの各PCM形式、キャンセル後の再実行、オフライン出力も検証しています。
配布ソースを新しいフォルダーでビルドし、同じJSが生成されることも確認しました。
[検証記録](https://github.com/cityedge/browser-media-i-o/blob/main/downloads/browser-mp3/verification.json)

Firefox／Safari／モバイルおよび `file://` での直接起動は未検証です。
CSPのあるアプリではWorkerのBlob URLを許可してください（`worker-src 'self' blob:`）。

ラッパーはMIT、エンコーダー `@breezystack/lamejs` 1.2.7はLGPL-3.0です。
再配布時は同梱ライセンス・ソース・再ビルド手順を保持してください。

[API仕様](https://github.com/cityedge/browser-media-i-o/blob/main/docs/MP3.md) ／
[ソースリポジトリ](https://github.com/cityedge/browser-media-i-o)
