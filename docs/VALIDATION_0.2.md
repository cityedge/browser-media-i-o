# Browser Media I/O 0.2.0：実装・評価結果

2026-10-03（日本時間）。承認済みの0.2を実装し、Linux Chromiumで検証しました。
編集・合成機能はアプリ側に残し、連続フレーム取得、読み取り単位の中止、PCM入出力を追加しています。
[APIと所有権の契約](API.md) ／ [承認計画・後続0.3](IMPLEMENTATION_PLAN.md)。

## 引き渡す機能

- `videoFrames()`：表示順の連続取得。指定区間と重なる元フレームを返す。
- `videoFramesAt()`：遅延消費する単調非減少の時刻列。空白はnull、反復取得は独立した所有権。
- 読み取りごとのsignal、`await reader.return()` を再利用完了点とする中止。単発取得とprobeも個別中止可能。
- `audioPcmBlocks()`／`writer.addPcm()`：AudioBufferに依存しない区間PCM入出力。
- `MediaFrame.flip`、`squarePixelWidth`／`squarePixelHeight`：GPU側で表示変換を再現するための情報。
- [WebGL描画例](../examples/webgl-frame.ts) と [二動画＋音声のWorker対応出力例](../examples/worker-export.ts)。

既存のAudioBuffer API、MP3、低レベルwriter、高水準renderMp4を維持しています。
0.3予定のレート変換、パケット時刻API、AudioData直接入力はまだありません。
0.2ではアプリで音源のサンプルレートとチャンネル数を揃えてください。

## 検証環境

| 項目 | 実測環境・状態 |
|---|---|
| OS | Debian GNU/Linux 13.6、Linux kernel 6.18.44 |
| CPU | Intel Xeon Platinum 8573C、ブラウザから見える論理CPU数5 |
| ブラウザ | `/usr/bin/chromium` 151.0.7922.173、headless、localhost |
| ツール | Node.js 24.19.0、Playwright 1.63.0、FFmpeg／ffprobe 7.1.5 |
| 固定依存 | Mediabunny 1.61.0、AAC拡張1.61.0 |
| H.264 | WebCodecs。ハードウェア利用を強制しない既定設定。実際のハードウェア処理は未確認 |
| AAC | 入力はネイティブデコード。出力は明示登録したWASM拡張。ネイティブエンコード対応判定はfalse |
| WebGL | ANGLE／Vulkan／SwiftShader。ソフトウェア描画で検証。GPU実機の性能値ではない |
| 実行領域 | Windowと実Dedicated Worker。WorkerではAudioBufferが未定義であることも確認 |
| Windows Chrome／Edge | **未検証**。編集アプリへの組み込み時に以下の同一手順で確認する |

30fpsリアルタイム再生、1080p／4K長尺、HDR、任意の破損素材、Firefox／Safari／モバイルの動作・性能は保証していません。

## 回帰テスト

`npm test`：**54件成功、失敗0、スキップ0**（Web 48件＋本番ビルドしたFramecraft 6件）。
既存39件を維持し、0.2向け15件を追加しました。[テスト結果・画素値・コーデック判定](reports/v0.2/regression.json)。
長尺・性能は別に `npm run test:release` の2件が成功しています。

| 検証 | 結果と基準 |
|---|---|
| Bフレーム、可変fps、開始オフセット | FFprobeのデコード後PTS／durationと順序・件数を照合 |
| 表示空白と境界 | 実素材のPTSを1、1.1、2、2.3秒、各durationを0.1秒に設定。1.2～2秒等でnull。開始途中／終了ちょうども検査 |
| 同一フレームの複数取得 | 一方をcloseしても別ハンドル・別VideoFrameを描画できる |
| 映像中止・再開 | 36回の初期化中／next待機中／yield中のabort、return直後の別位置取得。各return後のnative decoder生存数0、同時最大1 |
| AAC音声中止・再開 | 18回の同様の反復。各return後のnative audio decoder生存数0、同時最大1 |
| 処理待ち | 映像の消費停止後、待機を延ばしても追加デコード出力0。無限時刻列からnextを2回だけ呼ぶと消費時刻も2個 |
| 所有権と上限 | 個別abortは返却済みフレームを閉じない。入力closeは閉じる。reader終了後も未解放数の上限を維持 |
| 別入力 | 同一Blobの映像／音声を別入力で取得し、一方のabort後も他方が継続。同一入力の並行読み取りはBUSY |
| PCM | WAVの1秒区間48,000サンプル、337サンプル以下の分割、境界の欠落なし。Web Audioとの値の差は16bit量子化1段未満。入力close後のtransfer可 |
| WebGL＋PCM＋MP4 | 二動画300フレームずつを左右に描画。Window／Worker × Canvas／VideoFrameの4経路で、全フレーム番号・時刻・左右音声マーカーをFFmpegで照合 |
| Worker | AAC初期化中のwriter中止後に再出力。PCM読み取りの個別中止後に同一入力をprobeで再利用 |
| 正常な早期finish | expectedFrames未指定で3フレーム＋4,800サンプルを0.1秒のMP4として確定。映像0枚と過大な音声長不一致は拒否 |

デコーダーの生存数は、実WebCodecsのコンストラクター／closeを計測しています。デコーダーを模擬した成功ではありません。
ネイティブのcloseとJS参照の破棄を確認するもので、ブラウザ内部でメモリがOSへ返る時刻までは保証しません。

## WebGLの表示と画素値

入力はH.264、YUV420、limited range／BT.709申告、160×96、SAR 6:5。
正方画素の表示寸法192×96から0／90／180／270度×水平反転有無の8組を検証しました。
Canvas 2Dのdraw、WebGL描画、MP4出力後の再デコードを比較しています。visibleRectの部分領域も別途確認しています。

既知の中央5段階 `[0,64,128,192,255]` は今回、WebGL直後とMP4再デコード後の両方で同じ値でした。
四隅の `[32,96,160,224]` は通常向きで `[31,95,159,223]` と観測され、回転／反転でも期待位置に対応しました。
境界を含む画像全体のCanvas 2Dとの差は画素単位の補間差を含みます。基準は均一領域の既知値と四隅で、
入力／Canvas 2Dは最大4階調、WebGL／再圧縮後は最大6階調の許容幅を設定しています。
これはSDRの小さな既知パターンに対する回帰基準です。マット全体の完全一致やブラウザをまたぐ同じ数値を保証しません。

## 30分のストリーム出力

[生データ](reports/v0.2/long-1800s.json)。320×180、30fps、H.264 500kbps指定、48kHz stereo AAC。
Window内でフレームとPCMを逐次生成し、OPFSの実ファイルへ位置指定で保存しました。
保存先は各writeを2ms遅らせています。素材は単純な背景と16bitのフレーム番号、音声は3地点の短いマーカー以外は無音です。
一般的な撮影映像や音楽より圧縮しやすい条件です。

| 項目 | 観測値 |
|---|---|
| 確定した動画 | 1,800秒、54,000フレーム、5,953,672 bytes |
| 実処理時間 | 37.03秒。通常の再生時間を待つ録画処理ではない |
| 音声 | 86,400,000サンプル。独立デコードの結果も一致 |
| 映像確認 | FFprobeで全フレーム数。FFmpegで先頭0／中間27000／末尾53999の番号を確認 |
| 音声確認 | 左1／900／1799秒、右2／901／1799.5秒のマーカーを全て確認。5ms測定刻みでずれ0、許容5ms |
| 保存先 | write 7回、最大1MiB／回、同時write最大1、正常close／finalize |
| アプリ保持PCM | 12,800 bytesの配列を再利用（1,600サンプル×2ch×4 bytes） |
| アプリ保持映像 | OffscreenCanvas 1枚。入力MediaFrame／読み取りキャッシュなし |
| Window JSヒープ | 開始11.94MiB、中間31.89MiB、finalize直前23.31MiB、直後48.54MiB。観測範囲10.83～48.54MiB |
| Chromium全プロセスRSS合計 | 開始721.70MiB、完了847.43MiB、観測最大891.95MiB（9プロセス）。共有ページの重複を含む |

1分の素材時間ごとと確定後に32回計測しました。強制GCは使用していません。
JSヒープはWindowの指標で、AAC WorkerのヒープやGPU／コーデック全体のメモリを含みません。
通常MP4のパケット索引は尺に比例して保持され、finalizeで索引をシリアライズする際にも一時割り当てがあります。
今回のヒープ・RSS増分を索引・コーデック・GCごとの正確なバイト数へ分解できてはいません。
アプリ保持のPCM／Canvas、索引の増加、ブラウザ全体の指標は別物です。メモリ完全一定という結論にはしません。
入力側のキャッシュは一入力につき既定8MiB、videoFramesAtは現在＋次の2sampleを保持し、基盤キューとデコーダー参照画像が加わります。
旧デコーダーが中止回数に比例して残らないことは、長尺試験とは別の反復中止テストで確認しました。

## 二動画の処理時間・シーク

[全試行の生データ](reports/v0.2/performance.json)。同じ10秒のBlobを別入力で開いた動画2本を使用。
各320×180、30fps、H.264、GOP最大30、Bフレーム2、音声48kHz stereo AAC。
読み取り専用と、WebGLで640×180へ左右配置＋音声区間デコード＋AAC再出力を分けました。いずれもWindow。
OSのページキャッシュやブラウザの全内部状態を消した測定ではありません。

| 測定 | 回数 | 観測値 |
|---|---:|---|
| 新しく開いた入力での最初の二動画取得 | 6 | 中央値11.9ms、p95 36.8ms。最初の1回36.8ms |
| 二動画を全300ペア連続取得 | 1走査 | 合計66.4ms。1ペア待ち中央値0.2ms、p95 0.4ms。走査の最初3.8ms |
| 走査後のシーク、左入力の初動 | 24 | 中央値7.3ms、p95 10.2ms |
| 同、右入力の初動 | 24 | 中央値7.5ms、p95 9.9ms |
| 同、二入力が揃うまで | 24 | 中央値7.7ms、p95 10.4ms |
| 旧readerのreturn開始から二入力が揃うまで | 24 | 中央値7.9ms、p95 10.7ms |
| WebGL＋PCM＋MP4実ファイル確定 | 3 | 1,473.5／1,365.1／1,339.9ms（各10秒・300フレーム）。初回と反復を併記 |

新規入力の測定後に連続取得、その後シークを測りました。シークは8、0.9、7.9、1、6、2.9秒を4回反復。
順方向／逆方向、整数秒のキーフレーム位置とその手前を区別してJSONへ保存しています。
初動はreturn完了後から計測し、returnを含む値は別列です。p95は昇順のceil(n×0.95)番目、中央値はfloor(n/2)番目。
少数試行・低解像度・単純素材であり、編集アプリでの高解像度再生性能へ換算しないでください。

## 再現手順とWindows側の確認

Node.js 22.12以降、FFmpeg／ffprobe 7.1以降（libx264、AAC、libmp3lame入り）を用意します。
テスト素材は毎回生成されるため、手作業で動画を用意する必要はありません。

```sh
git clone https://github.com/cityedge/browser-media-i-o.git
cd browser-media-i-o
npm ci
npx playwright install chromium
npm test
node scripts/collect-validation.mjs
npm run test:release
```

通常テストは短尺、test:releaseは30分の素材時間と性能測定です。再実行時はreports/v0.2のJSONを更新するため、
比較用の既存結果は別ディレクトリへ残すか、MEDIA_REPORT_DIRを指定してください。
FFmpeg／ffprobeのパスはFFMPEG_PATH／FFPROBE_PATH、ブラウザ実行ファイルはPLAYWRIGHT_CHROMIUM_EXECUTABLE_PATHで指定できます。

Windowsの実Chrome／Edgeで確認する場合のPowerShell例（各環境の実パスへ変更）:

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:MEDIA_REPORT_DIR = 'docs/reports/windows-chrome'
npm test
node scripts/collect-validation.mjs
npm run test:release
# Edgeではmsedge.exeを指定し、出力先をwindows-edgeへ変更して同じ手順を実行
```

GPU／AACが利用できない場合はテスト失敗として記録します。自動スキップして対応済みとは扱いません。
AACのnative対応判定と実際に使用したbackendは別々に記録します。
編集アプリでは素材2本＋音声を別入力で開き、シーク時にabort→await return→新readerの順に切り替え、
WebGL変換と音声ブロック配置を接続してください。まず揃えたWAVのレート／チャンネル数で評価できます。

## 実装上の保守点

Mediabunny 1.61.0の公開iterator.returnは内部の背景処理終了を待たないため、
`src/decoder-session.ts` がinstanceの `_createDecoder`／`_createPacketSink` に接続しています。
依存は完全固定です。依存更新時にこのアダプターを点検し、映像／音声の反復中止・資源数テストを必ず再実行してください。
依存本体を書き換えたり、グローバルなデコーダーを製品コードで差し替えたりはしていません。
