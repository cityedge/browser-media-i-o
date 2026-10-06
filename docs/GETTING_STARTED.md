# 導入ガイド — 0.4.0

利用アプリをローカルサーバーなしで動かす場合は、通常script版JSをアプリのHTMLから読み込みます。
通常scriptでの導入方法と制限は [ローカルHTML配布](LOCAL_DISTRIBUTION.md) を参照してください。
以下はnpm / ES Modules版の導入方法です。

Browser Media I/Oは、Webアプリにメディアの入力・情報取得・MP4／MP3出力を加えるライブラリです。
描画、字幕、音声ミックス、編集タイムラインはアプリ側で用意します。

## 導入方法を選ぶ

| 用途 | 利用するもの | 開発時に必要なもの |
|---|---|---|
| ローカルサーバーなしでMP4/MP3入出力 | 通常script版のbrowser-media-io.js | 配布JSをアプリにコピー。利用時はNode.js不要 |
| MP4の読み取り・情報取得・出力、WorkerでのPCM処理 | `browser-media-io` パッケージ | Node.js 22.12以降、npm、Vite等のバンドラー |
| npmを使うアプリのWAV／AudioBufferからMP3出力 | パッケージの `browser-media-io/mp3` | 同上 |
| 通常のHTMLへMP3保存だけを追加 | `dist/standalone/browser-mp3.js` | ビルド不要。JSをアプリにコピー |

ES Modules版はHTTPSまたはlocalhostで実行し、WebCodecsの利用可否を確認してください。
通常script版はWindows Chrome/Edgeのfile://でも検証しています。
本番サーバーでFFmpegを動かす必要はありません。FFmpeg／ffprobeはこのライブラリの開発テストでだけ使います。

## npm用tgzをインストール

配布ファイルは `browser-media-io-0.4.0.tgz` です。
GitHub Releasesから取得するか、ソースでnpm ci → npm run build → npm packを実行して生成します。
利用先アプリの `package.json` があるディレクトリで、実際のパスを指定します。

```sh
npm install --save-exact /path/to/browser-media-io-0.4.0.tgz mediabunny@1.61.0
# ネイティブAAC非対応環境でもAAC出力する場合
npm install --save-exact @mediabunny/aac-encoder@1.61.0
```

Windowsでは引用符で囲んだパス（例: `npm install --save-exact "C:/Downloads/browser-media-io-0.4.0.tgz" mediabunny@1.61.0`）も使えます。
まだnpmレジストリへ公開していないため、パッケージ名だけの `npm install browser-media-io` は導入手順ではありません。
Mediabunny 1.61.0は依存としてnpmが取得します。tgzにnode_modulesは含めていません。
インストールにはnpmレジストリへの接続が必要ですが、変換処理そのものはブラウザ内で完結します。

Mediabunnyはアプリ側にも1.61.0を完全固定します。AAC拡張は同じMediabunnyへ登録される必要があり、
本体の1.61.0と拡張側の1.61.1などが併存すると、拡張を登録してもAACがUNSUPPORTEDになることを確認しました。
`--save-exact` で意図しない範囲指定を避け、`npm ls mediabunny @mediabunny/aac-encoder` で1.61.0に揃っていることを確認してください。
既存アプリに別版のMediabunnyがある場合は、この条件に揃えてから組み込んでください。

MP4のES Modulesはバンドラーでアプリに組み込んでください。`dist/index.js` を通常のscriptタグに直接指定する形式ではありません。
MP3の `dist/standalone/browser-mp3.js` は、エンコーダーを含む通常script用の別配布です。

## 内部APIへの接続を避ける場合

```ts
import { openMedia, probe, createMp4Writer } from 'browser-media-io/public';
```

既存の `browser-media-io` と同じ関数名で利用できます。映像・音声の読み取り機能は同じです。
/publicからはMediabunnyの非公開メソッドを差し替えるコードを読み込みません。
キャンセル時は `abort()` と `await reader.return()` を行ってから次の読み取りへ進みます。
returnが完了しても基盤の後片付けが一時的に続く可能性があります。
旧デコーダーのclose完了まで待つ必要があるアプリは、従来の `browser-media-io` を選んでください。
[終了保証の比較](API.md#入力apiの選択021) ／ [読み取りの利用例](../examples/public-input.ts)。

この選択でパッケージの依存バージョンは変わりません。上記のMediabunny／AAC拡張の導入条件は両方に適用します。

## 最小のMP4出力

音声なしならAAC拡張は不要です。Canvasへ描画した90フレームを3秒のMP4にします。

```ts
import { getCapabilities, renderMp4 } from 'browser-media-io';

const capabilities = await getCapabilities({ width: 320, height: 180 });
if (!capabilities.h264Encode) throw new Error('この環境はH.264出力に対応していません。');

const result = await renderMp4({
  width: 320, height: 180, fps: 30, duration: 3,
  renderFrame(ctx, time) {
    ctx.fillStyle = '#152333'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif';
    ctx.fillText(`${time.toFixed(2)} 秒`, 24, 96);
  },
});
// result.blob が完成したMP4。以降はアプリのBlob保存処理へ渡す。
```

音声付きの小さな出力は [Canvas＋音声の例](../examples/canvas-with-audio.ts)、
長尺やWorkerでは [二動画＋PCMの例](../examples/worker-export.ts) を参照してください。
音声付きAAC出力では、処理するWindow／Worker内で `enableAacFallback()` を明示的に呼びます。

```ts
import { enableAacFallback } from 'browser-media-io/aac';
const backend = await enableAacFallback({ width: 320, height: 180, sampleRate: 48000, channels: 2 });
// backendは 'native' または 'wasm'。WASM拡張を使う場合は上記の追加インストールが必要。
```

## 入力とフレームの解放

```ts
import { openMedia } from 'browser-media-io';

const input = await openMedia(file); // fileは利用アプリが選択したFile／Blob
try {
  const info = await input.probe();  // 既定はパケット走査。ヘッダー値と区別する
  for await (const frame of input.videoFrames({ start: 0, end: 3 })) {
    try {
      frame.draw(context);          // アプリのCanvas 2D context
    } finally { frame.close(); }
  }
} finally { input.close(); }
```

指定時刻ごとの取得には `videoFramesAt(times)` を使います。結果は `{time,frame}` で、表示空白ではframeがnullになります。
映像と音声を同時に読む場合は、同じBlobを別々の `openMedia()` で開きます。
同じ入力の操作は排他的で、読み取り中に別の操作を始めるとBUSYになります。

シークの切り替えは `controller.abort()` → `await reader.return()` → 次のreader作成の順に行ってください。
待機中の `next()` の結果・ABORTED例外も利用側で処理します。個別abortは返却済みフレームを閉じません。
入力自体のcloseはその入力の未解放MediaFrameを閉じます。

Workerでは `audioPcmBlocks()` と `writer.addPcm()` を利用します。音声のレートとチャンネル数は出力設定に揃えてください。
0.2には自動リサンプリング・ミックス・元timestampに従った配置はありません。writerへは0秒から連続追加されます。
[APIと所有権・キャンセルの契約](API.md) に詳細があります。

## WAV保存にMP3の選択肢を追加

```ts
import { wavToMp3 } from 'browser-media-io/mp3';
const blob = format === 'mp3' ? await wavToMp3(wavBlob) : wavBlob;
```

通常のHTMLでは、MP3専用ZIPの `browser-mp3.js`（ビルド時はdist/standalone/）をコピーして読み込みます。

```html
<script src="browser-mp3.js"></script>
<script>
  async function convert(wavBlob) {
    return await BrowserMp3.wavToMp3(wavBlob);
  }
</script>
```

切り替えを試すHTMLは `dist/standalone/index.html` です。
通常script版のMP4/MP3統合例は `dist/browser/examples/local/index.html` を直接開いて利用できます。
MP3にはWorkerとBlob URLが必要です。CSPを指定している場合は `worker-src 'self' blob:` を許可してください。
[MP3 API・入力形式・ビットレート](MP3.md) ／ [第三者ライセンス](../THIRD_PARTY_NOTICES.md)。

## 問題が起きたとき

| 状況 | 確認する点 |
|---|---|
| UNSUPPORTED | secure contextとWebCodecs、要求したコーデックの対応。AAC拡張は使う実行領域で登録し、本体と同じMediabunny 1.61.0を使用する |
| BUSY | 先の操作／reader.returnをawaitしたか。同時の映像・音声は別入力に分ける |
| RESOURCE_LIMIT | フレームのclose、Blob出力の上限。長尺出力は位置指定可能なストリームを使う |
| 音声の追加が拒否される | sampleRate／numberOfChannelsがwriterの設定と一致するか |
| MP3 Workerが起動しない | CSPのworker-src、Blob URLの許可、ブラウザ側の例外 |

不具合の報告には、ブラウザ・OS、使ったAPI、MediaError.code、AAC backend、素材の構成、短い再現手順を添えてください。
[検証済み条件・未検証範囲](VALIDATION_0.2.md) ／ [変更履歴](../CHANGELOG.md) ／ [再ビルド・テスト](BUILDING.md)。
