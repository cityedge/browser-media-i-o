# H.264映像コピー＋加工済みPCM（0.7.0）

SPSの`gaps_in_frame_num_value_allowed_flag`のみで拒否せず、実際のフレーム番号の連続性を確認します。
既定の通常モードでは実際の不連続や、MMCOによる番号リセットなど追加の解釈が必要な構造は引き続き拒否します。
既定の厳格検査を通る範囲の拡充であり、検査を自動的に省略する機能ではありません。

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

`openVideoCopy(file, {videoTrackId?,signal?,validation?})`はBlob/Fileを開きます。ID省略時は先頭の映像トラックです。
`validation`は`'strict'`（既定）または`'container'`。セッションを開いた後の変更はできません。
`inspect()`は全圧縮パケットを順に読み、必要なヘッダーと時刻を検査します。映像の全デコードはしません。
圧縮データは保持せず、パケット索引だけを残します。結果はキャッシュされ、変更できません。

結果にはトラックID、元の開始・終了時刻、時間単位、パケット数、寸法、回転、SAR、色、変換行列、
キーフレーム間隔の最小／最大／平均、`boundaries`が含まれます。
各境界は`{id,time,tick,kind:'idr'|'sync'|'eof'}`です。通常モードは`idr`、強行モードは`sync`。EOFは終了専用です。
`findBoundaries(time)`で直前／直後の境界を取得できます。範囲外は該当側がnullです。
非対応の場合は`VideoCopyError`を投げます。強行モードの`sync`は独立復号を検証済みのIDRではありません。

以下は既定の通常モードの検査です。安全な単位は、確認済みIDRから次のIDR直前、またはEOFまでです。
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

## 警告があっても出力する設定

```js
const copy = await BrowserMediaIO.openVideoCopy(file, { validation: 'container' });
try {
  const info = await copy.inspect();
  const plan = await copy.plan({
    keepRanges: [{ start: info.startTime, end: info.endTime }], snap: 'strict',
  });
  console.log(plan.warnings, plan.omittedVideoPackets, plan.adjustedVideoPackets);
  const result = await copy.exportMp4({ plan });
  // result.blobを保存。result.warningsにも採用した計画の警告が入る。
} finally { await copy.close(); }
```

`container`はMP4の同期サンプルを境界として使います。独立復号の証明に関する下記の問題を警告に変え、
コピーを続行します。自動再試行や自動再圧縮はありません。Open GOPの参照画像不足などによって
切断直後の映像が乱れる可能性があり、出力成功は再生品質の保証ではありません。
`supported:true`も選択したモードで処理可能という意味です。

`validation`と変更不可の`warnings`はinfo・plan・resultに含まれます。
通常モードで検出する境界は`idr`、強行モードでは実際にIDRであっても`sync`と表示します。
`findBoundaries`・`plan`・`exportMp4`はセッションの同じ設定を引き継ぎます。
`snap:'strict'`は境界との完全一致を指す別の設定で、`validation:'container'`とも組み合わせられます。

| warning.code | 続行する条件／処理 |
|---|---|
| CONTAINER_SYNC_UNVERIFIED | 強行モードであることを常に通知 |
| SYNC_IDR_MISMATCH | MP4同期フラグと実際のIDRが不一致（Open GOP等） |
| FRAME_NUMBER_DISCONTINUITY | gap許可SPSでフレーム番号の連続性を確認できない |
| SLICE_LAYOUT_UNVERIFIED | 先頭／順番から完全なスライス配置を確認できない |
| REDUNDANT_PICTURE | 冗長画像を含む |
| IDR_DISCARDS_PRIOR_PICTURES | IDRが先行画像を表示しない指定を持つ |
| GOP_TIMING_MISMATCH | GOP復号時間と表示境界が一致しない |
| GOP_PRESENTATION_CROSSING | GOPの表示時刻が境界をまたぐ |
| LEADING_PICTURE | 同期サンプルより前に表示する画像がある |
| PACKETS_OMITTED | 保持区間外の表示時刻のパケットを省略 |
| PACKET_DURATION_ADJUSTED | 区間末尾のパケット時間を調整 |
| DIAGNOSTICS_TRUNCATED | 将来の診断種類追加などで上限を超えた種類を集約 |

警告はコードごとに集約し、配列は最大32件です。`severity:'warning'`、`recoverableInContainer:true`、
`message`、発生回数`count`を持ちます。該当時は`firstTime/lastTime`（元ファイルの秒）、
`firstRangeIndex/lastRangeIndex`（0始まり）も返します。first/lastは検出順で、Bフレームでは時刻順とは限りません。
時間調整には最初の例の`originalDuration/outputDuration`（秒）を添えます。
infoの警告は入力全体、planの警告はそれらに保持区間の処理結果を加えたものです。

強行モードの区間端の処理は次のとおりです。

1. 開始syncから終了syncの直前（またはEOF）までを元の復号順で読みます。
2. その中で表示時刻が`[sourceStart,sourceEnd)`の外にあるパケットを省略します。隣接GOPから画像を補いません。
3. 残った最後の復号パケットと最後の表示パケットのdurationを、最後の表示時刻から区間末尾までの長さへ揃えます。同一パケットは1件と数えます。
4. 元の圧縮ペイロード・残ったパケットの復号順を保持し、表示時刻を出力区間へ移します。参照画像の修復は行いません。

省略／時間調整の件数は各range・plan・resultの`omittedVideoPackets/adjustedVideoPackets`にあります。
`videoPackets`は省略後の出力件数、音声のサンプル数は調整後の区間時間から計算します。
通常モードのこれらの件数は0で、従来の末尾時間処理を維持します。

**強行モードでも停止するもの:** 読み取れないNAL／ヘッダー、SPS/PPS・sample descriptionの変更、
重複・負値・ゼロ長などの不正な時刻、無効な復号順、開始syncなし、非対応コンテナ／コーデック／表示構造、
不正な範囲・別セッションの計画、PCMの不足や形式不一致、容量上限、保存失敗、中止。
インターレース・FMO・POC type 1等の非対応形式も引き続き停止します。
警告が出た後もNALおよびSPS/PPS検査を続け、検査器全体を無効化する処理はありません。

## planと音声の時間対応

保持区間は元の時刻の`[start,end)`で、有限値・時刻順・重複なし・映像の有効範囲内です。
`strict`は選択モードの境界との一致を要求し、`inside`は開始を後ろ、終了を前の境界へ縮めます。
一致判定の許容差は浮動小数点演算のノイズ程度です。`info.boundaries`の時刻をそのまま使えます。
空になった区間は`EMPTY_RANGE`と0始まりの`rangeIndex`を伴うエラーです。黙って捨てません。

`plan.ranges`の情報:

| フィールド | 内容 |
|---|---|
| requestedStart / requestedEnd | アプリが要求した区間 |
| sourceStart / sourceEnd | 実際に保持する元区間 |
| startAdjustment / endAdjustment | 実際の時刻−要求時刻 |
| startBoundaryId / endBoundaryId | 選択モードで採用した境界 |
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
`severity:'error'`、`diagnosticCode`、`recoverableInContainer`も返します。
通常モードで上表の証明関連エラーが出た場合は`recoverableInContainer:true`となり、
アプリは明示的な強行設定で新しいセッションを作れます。その他のVideoCopyErrorはfalseです。
一般のMediaError（保存失敗・中止等）はこの追加情報を持たない場合があります。
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
