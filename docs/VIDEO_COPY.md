# H.264映像コピー＋加工済みPCM（0.6.0）

単一MP4の保持区間を元の順序で連結し、H.264映像を再圧縮せずに出力します。
アプリで加工したplanar Float32 PCMをAACにして組み合わせることもできます。
`VideoDecoder`／`VideoEncoder`、Canvas、映像エンコーダー能力の検査はコピー経路で使いません。
映像データのバイト列は保持しますが、MP4の索引・時刻・音声は書き直します。

## 入口と実行環境

- npm: `import { openVideoCopy, VideoCopyError } from 'browser-media-io'` または`browser-media-io/public`。
- 通常script: `BrowserMediaIO.openVideoCopy`または`BrowserMediaIOPublic.openVideoCopy`。
- Window／Dedicated Worker。両入口のコピー機能と終了契約は同じです。Mediabunnyの公開パケットAPIだけを使います。
- 配布JSはfile://・HTTPSで動作し、実行時のサーバー・CDN・追加WASMダウンロードは不要です。
- 日英の操作例は通常版ZIPの`examples/video-copy/index.html`。ZIPを展開して直接開けます。
- ソースでの操作例は`examples/video-copy/`。`npm run build`後の`dist/browser/examples/video-copy/index.html`を開きます。

## 最小の使用例

```js
const copy = await BrowserMediaIO.openVideoCopy(file, { videoTrackId });
try {
  const info = await copy.inspect({ signal, onProgress });
  const plan = await copy.plan({
    keepRanges: [{ start: 12.3, end: 1200.4 }, { start: 1500.2, end: info.endTime }],
    snap: 'inside', audioSampleRate: 48000, signal,
  });
  // このplanを画面に表示し、同じ調整後のsourceStart/sourceEndで音量解析を行う。
  await BrowserMediaIO.enableAacFallback({ sampleRate: 48000, channels: 2, audioBitrate: 80000 });
  const result = await copy.exportMp4({
    plan,
    audio: {
      mode: 'pcm', sampleRate: 48000, channels: 2, codec: 'aac', bitrate: 80000,
      blocks: readSignal => processedPcmBlocks(plan, readSignal), // 利用アプリが実装
    },
    target: { kind: 'stream', stream: destination },
    signal, onProgress,
  });
} finally { await copy.close(); }
```

AAC事前確認の`audioBitrate`と出力の`audio.bitrate`は同じ値にします。
ビットレートの単位はbits/sです。音声なしでは`audio`を省略するか`{mode:'none'}`を指定し、AAC登録は不要です。
`target`省略時はBlob（既定上限256 MiB）です。`{kind:'blob',maxBytes}`で変更できます。
ストリームは`{type:'write',position,data}`を扱う既存`Mp4Target`と同じ契約です。
`showSaveFilePicker()`は利用アプリがユーザー操作内で呼び、そのハンドルの`createWritable()`を渡します。
ブラウザが保存先選択を提供しない場合は、利用アプリでBlob等の保存方法を選んでください。

## inspectと安全な境界

`openVideoCopy(file, {videoTrackId?,signal?})`はBlob/Fileを開きます。ID省略時は先頭の映像トラックです。
`inspect()`は全圧縮パケットを順に読み、必要なヘッダーと時刻を検査します。映像の全デコードはしません。
圧縮データは保持せず、パケット索引だけを残します。結果はキャッシュされ、変更できません。

結果にはトラックID、元の開始・終了時刻、時間単位、パケット数、寸法、回転、SAR、色、変換行列、
キーフレーム間隔の最小／最大／平均、`boundaries`が含まれます。
各境界は`{id,time,tick,kind:'idr'|'eof'}`です。EOFは終了専用です。
`findBoundaries(time)`で直前／直後の境界を取得できます。範囲外は該当側がnullです。
非対応の場合は`VideoCopyError`を投げます。未検査の位置を安全とする部分結果は返しません。

安全な単位は、確認済みIDRから次のIDR直前、またはEOFまでです。
同期サンプルフラグと実際のIDR、全スライスの設定、復号順序、各GOPの表示時刻範囲、時間の連続性を照合します。
IDRで参照画像がリセットされる構造に限り、区間前後の参照が欠けない単位でコピーします。
任意の破損ビットストリームを完全に復号・検証する機能ではありません。

初期対応は、非フラグメントMP4の`avc1`、単一SPS／PPS、8-bit 4:2:0、プログレッシブ、
baseline/main/extendedの通常スライス／highプロファイル、POC type 0／2です。Closed GOPのBフレーム・VFRに対応します。
Open GOP、同期フラグ不整合、構成変更、複数sample description、インターレース、FMO、POC type 1、
先行表示画像、複数の編集区間、暗号化、sample groups、fragmented MP4、ICC色プロファイル、clap等は拒否します。
単一の通常editと先頭の空editは扱いますが、画像を間引くedit／prerollは拒否します。
末尾の最終画像の表示時間だけを短縮するeditは保持します。
未知の表示構造は拒否し、黙って再圧縮へ切り替えません。

## planと音声の時間対応

保持区間は元の時刻の`[start,end)`で、有限値・時刻順・重複なし・映像の有効範囲内です。
`strict`は安全な境界との一致を要求し、`inside`は開始を後ろ、終了を前の境界へ縮めます。
一致判定の許容差は浮動小数点演算のノイズ程度です。`info.boundaries`の時刻をそのまま使えます。
空になった区間は`EMPTY_RANGE`と0始まりの`rangeIndex`を伴うエラーです。黙って捨てません。

`plan.ranges`の情報:

| フィールド | 内容 |
|---|---|
| requestedStart / requestedEnd | アプリが要求した区間 |
| sourceStart / sourceEnd | 実際に保持する元区間 |
| startAdjustment / endAdjustment | 実際の時刻−要求時刻 |
| startBoundaryId / endBoundaryId | 採用した安全な境界 |
| outputStart / outputEnd | 完成動画上の時刻 |
| audioStartSample / audioEndSample / audioSamples | 完成音声上の位置・区間サンプル数 |

全体には`duration`、`videoPackets`、`audioSampleRate`、`audioSamples`があります。
音声の指定がない計画ではサンプル数はnullです。区間ごとの独立丸めはせず、
元の整数tickを累積し、各境界で整数演算による`round(tick * rate / timeResolution)`を求めます。
連続するサンプル境界の差を区間サンプル数とするため、多区間でも丸め誤差が累積しません。

計画はそのセッションにひもづいた変更不可オブジェクトです。別セッションの計画、JSON化して復元したもの、
`structuredClone()`したものは拒否します。プロジェクト保存時は要求区間を保存し、ファイルを開き直して再計画します。

## PCM供給と終了契約

`blocks(signal)`は`AsyncIterable<PcmAudio>`を返します。各ブロックはplanar Float32で、
`sampleRate`、`numberOfChannels`、`length`、`channelData`を持ちます。1ブロックは最大10秒分です。
全区間のPCMを作ってから渡す必要はありません。ライブラリは最大4096サンプルずつAACへ渡し、
映像と交互に進め、保存先のwriteをawaitします。入力PCMのtimestampは使用しません。
サンプル数の不足・超過、非有限値、異なるレート・チャンネル数はエラーです。
入力配列はコピーしてからエンコーダーへ渡します。アプリは次のnext()まで借用中の配列を変更しないでください。

`examples/video-copy/pcm.js`は時刻付きPCMを計画へ配置するアプリ側の実例です。
元音声の開始遅延や空白を無音で補い、各区間を計画のサンプル数へ揃え、processコールバックで音量加工できます。
サンプルレート変換／チャンネル変換は行いません。原音と異なる設定が必要なら利用アプリ側で処理してください。
ライブラリ本体は無音補完・レベリング・LUFS補正を自動実行しません。

AACのWASM経路は既存の1024サンプルのpriming補正を共用します。確定時にMP4のedit listで
先頭遅延と計画の表示時間を指定し、符号化上必要な末尾パケットを保持します。
MP4編集情報を無視して生のAACを取り出したデコーダーでは、末尾に最大1 AACフレーム程度の余剰PCMが見える場合があります。

同じセッションの操作は排他です。前のPromiseを待たずに操作するとBUSYになります。
中止時はPCM供給のsignalをabortし、進行中next()が決着してからreturn()を呼びます。
AACの進行中add/init/finalizeは決着を待ってから後始末します。`close()`は中止を通知し、進行中操作の終了後に入力を破棄します。
非協調的なPCM next()/return()や保存先writeまで一定時間で停止する保証はありません。
保存先は出力準備後のgetWriter成功時に引き受け、成功時close、異常時abortを試み、最後にロックを解放します。
既にエラー状態のWritableStreamでは、abortを呼んでも基底sinkのabortコールバックが呼ばれない場合があります。

## 結果・エラー・進捗

結果は`videoMode:'copy'`、適用計画、時間、全体／映像バイト数、実測平均映像ビットレート、
映像パケット数、PCMサンプル数、コーデック、表示寸法・回転を含みます。固定fpsという結果は返しません。
`fps`、リサイズ、映像ビットレート等の再圧縮設定を渡すと`CONFLICTING_OPTIONS`になります。

`VideoCopyError extends MediaError`には既存codeに加えてreasonと必要時rangeIndexがあります。
主なreasonはCONTAINER、CODEC、CONFIGURATION_CHANGE、GOP_STRUCTURE、DISPLAY_METADATA、TIMELINE、
NO_SAFE_BOUNDARY、EMPTY_RANGE、INVALID_RANGE、PLAN_MISMATCH、PCM_LENGTH、PCM_FORMAT、LIMITです。
索引は最大400万パケット、1パケット32 MiB、メタデータ読取1回64 MiB、時間単位は最大100万tick/sです。

進捗は`inspecting`（fraction:null）、`copying`、`finalizing`、`complete`です。
fraction:1はMP4確定と保存先closeの成功後だけ通知します。

## ビルドと検証

```sh
npm ci
npm run build
npm run test:video-copy
npm run test:video-copy:long
node scripts/test-video-copy.mjs --https
npm run package:release
```

Chrome／Edgeを指定する場合は`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`を設定します。
HTTPS試験はWindows PowerShell 7で一時自己署名証明書を作り、localhostだけで試験します。
配布物を試験する場合は`VIDEO_COPY_BUNDLE_DIR`に展開した通常版ZIPのルートを指定します。
ソース、MITライセンス、既存第三者通知は従来の配布方法を維持しています。追加の外部依存はありません。
