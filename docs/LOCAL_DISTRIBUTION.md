# 通常HTML・file://での組み込み

この配布形式は、利用アプリが自分のindex.htmlを直接開いて動くためのライブラリです。
同梱サンプルのUIを採用する必要はありません。

## 配置するファイル

`browser-media-io-browser-0.4.0.zip` を展開し、次のJSのどちらか一つを利用アプリへコピーします。
再配布時は通知・ライセンス・対応ソースの案内も保持してください。

| ファイル | グローバル名 | 入力終了の契約 |
|---|---|---|
| browser-media-io.js | BrowserMediaIO | 従来版。reader.returnはデコーダーcloseまで待機 |
| browser-media-io-public.js | BrowserMediaIOPublic | 公開API版。ラッパー終了・入力再利用まで待機 |

どちらもAAC拡張・WASM・MP3 Workerを内蔵します。実行時の追加ダウンロードはありません。
各バンドルは独立したMediabunnyを持つため、一つのページにはどちらか一方を使ってください。
既存npm版のルート・/public・/aac・/mp3の契約は変わりません。

```text
my-app/
  index.html
  app.js
  lib/
    browser-media-io.js
    LICENSE.md
    THIRD_PARTY_NOTICES.md
    SOURCES.md
    licenses/
```

## 最小の入力例

```html
<input id="file" type="file" accept="video/mp4,audio/*">
<pre id="info"></pre>
<script src="./lib/browser-media-io.js"></script>
<script>
  document.querySelector('#file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    let input;
    try {
      input = await BrowserMediaIO.openMedia(file);
      document.querySelector('#info').textContent =
        JSON.stringify(await input.probe(), null, 2);
    } catch (error) {
      document.querySelector('#info').textContent = error.message;
    } finally { input?.close(); }
  });
</script>
```

通常のscriptタグを使い、type="module"は付けません。
File/Blobを渡すので、ローカル素材をfetchする必要はありません。
アプリ自身のJSやその他の依存も、file://から読める通常script等の構成にしてください。
ライブラリの導入だけで、アプリ内のすべてのES Modules・fetch・Service Workerの制限が解消するわけではありません。

## 出力

```js
const api = BrowserMediaIO;
const audio = await api.decodeAudio(audioFile);
await api.enableAacFallback({
  sampleRate: audio.sampleRate, channels: audio.channels
});
const result = await api.renderMp4({
  width: 640, height: 360, fps: 30, duration: audio.duration,
  audio: audio.buffer,
  renderFrame(ctx, time) {
    ctx.fillStyle = '#152333'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = 'white'; ctx.font = '28px sans-serif';
    ctx.fillText(time.toFixed(2), 32, 64);
  }
});
// result.blobを既存アプリの保存処理へ渡す。
// 完成済みWAVなら: const mp3 = await api.wavToMp3(wavBlob);
```

Blob URLとdownload属性で保存できます。URLはダウンロード完了後や画面終了時に解放してください。
file://からのshowSaveFilePickerによる直接ストリーム保存は未検証です。
MP3とWASM AACにはBlob Workerが必要です。CSPを設定するアプリは必要なWorker/WASMの許可を設定してください。

## 任意のサンプル

ZIP内の `examples/local/index.html` を直接開くと、ファイル選択 → MP4/MP3生成 → 保存を試せます。
日英切替・ダークテーマに対応しています。このサンプルだけに60秒・音声PCM128 MiB・出力128 MiBの上限があります。
MP4は最大1280×720・30fpsに変換し、音声のみの素材には背景を生成します。
ライブラリ自体に60秒の固定上限があるわけではありません。
0.4.0からVBR・CBR・CQP、目標映像Mbpsまたは量子化値、エンコーダー優先を設定できます。
完成後は要求設定と実測平均映像Mbpsを表示します。非対応の設定では変更を案内します。
ライブラリへは `videoBitrateMode`、`videoBitrate` / `videoQuantizer`、`videoHardwareAcceleration` を渡します。
映像の制御方式はVBR/CBR/CQPに対応しますが、目標Mbpsとの厳密な一致は保証しません。

## 開発者による生成

```sh
npm ci
npm run package:browser
```

通常script版は `dist/browser/`、軽量ZIPは `output/releases/browser-media-io-browser-0.4.0.zip`。
対応ソースZIPは `npm run package:sources` で別途生成します。
利用者のPCにはNode.js・サーバー・ネット接続は不要です。

Windows Chrome/Edgeで、ZIPを日本語・空白パスに展開して初回からオフラインで試験しています。
試験コマンドは `npm run test:local`。ブラウザはPLAYWRIGHT_CHROMIUM_EXECUTABLE_PATHで指定します。
管理ポリシーでfile://が拒否される環境は、制限を緩和せず失敗として記録します。
Safari/Firefox/モバイル、長尺file://出力は未検証です。

English: Copy either classic JS bundle into your application and load it with a regular script tag.
Your own index.html can run from file:// without a local server, Node.js, CDN, or runtime downloads.
Pass user-selected File/Blob objects. The optional example is separate from the library.
Application-level module imports or fetch calls may still need changes for file://.

[API reference](https://github.com/cityedge/browser-media-i-o/blob/main/docs/API.md) /
[Sources and rebuilding](https://github.com/cityedge/browser-media-i-o/blob/main/docs/SOURCES.md)
