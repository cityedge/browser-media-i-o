# 変更履歴

## 0.3.0

- `BrowserMediaIO` / `BrowserMediaIOPublic` の通常script版を追加。既存npm版と両入力APIの契約は維持。
- AAC拡張・WASM・MP3 Blob Workerを同梱し、初回から通信なしでfile://から実行可能に。
- 利用アプリのindex.htmlから通常scriptを読み込める配布を追加。日英・ダークテーマの小さな組み込み例を添付。
- Windowsでも生成できる `package:browser` と、実際のZIP展開後に検査する `test:local` を追加。
- 日本語・空白パス、Chrome/Edge、ネイティブAAC/WASM、公開API単独バンドルを検証。
- 組み込み用の軽量ZIPと対応ソースZIPを分離。ライセンス・ソース入手先・再ビルド手順を整備。
- リポジトリはソース・API文書・利用例・検証を中心に整理。引き継ぎ資料、旧試作、別アプリ用配布物と重複ZIPを公開ツリーから除外。既存0.2.0/0.2.1はGitHub Releasesに保持。

## 0.2.1

- `browser-media-io/public` を追加。Mediabunnyの公開APIだけで、同じ入力・情報取得・出力APIを利用できます。
- `openMediaPublic()` を追加。従来の `openMedia()` と終了保証を分け、呼び出しごとに選択できます。
- 従来APIはデコーダーclose待ちを維持。公開API版はラッパーの終了と入力再利用まで待ち、基盤の背景処理の終了は待ちません。
- 時刻境界・所有権・入力排他・PCM処理を共通化し、両入口で同じ回帰テストを実行します。
- 公開API入口の依存グラフ、Window／WorkerでのMP4＋AAC往復、反復中止後のデコーダー解放を検証しました。
- ビルド・型検査と65件の回帰テストが成功。[0.2.1の評価記録](docs/VALIDATION_0.2.1.md) に条件・測定値を記載。
- 両APIが共存するため、Mediabunny 1.61.0の固定は継続します。0.2.0の既存配布物は保持します。


## 0.2.0

実装: 2026-10-03。ZIP配布・導入文書の整備: 2026-10-04（日本時間）。
今回の配布整備ではライブラリの実装と公開APIを変更せず、バージョンを0.2.0に維持しています。
AAC拡張と本体で異なるMediabunnyが読み込まれないよう、利用アプリ側にも1.61.0を完全固定する導入手順を明記しました。
新しいフォルダーへの初回展開でも検証できるよう、テスト素材を生成してからViteを起動する順序に修正しました。

### 追加

- `videoFrames()` による表示順の連続取得、`videoFramesAt()` による指定時刻列の取得。
- 読み取り単位のsignalと、終了・入力再利用の完了点になる `await reader.return()`。
- Workerで使える `audioPcmBlocks()`／`writer.addPcm()`。
- `MediaFrame.flip` と回転前の表示寸法 `squarePixelWidth`／`squarePixelHeight`。
- WebGL・Dedicated Workerの利用例、境界・資源解放・PCM・描画の回帰テスト。
- 30分ストリーム出力と二動画の取得・シーク性能の測定結果。

### 0.1から移行する際の確認

既存のAudioBuffer API、renderMp4、MP3出力は維持しています。
`getVideoFrame()` はフレームの半開表示区間を判定し、空白や末尾の終了時刻以降ではnullになります。
直前のフレームを保持したい場合はアプリ側で判断してください。
音声ブロックの長さを一定と仮定せず、返却された実サンプル数を使って処理してください。

同一入力の排他制御は維持しています。映像・音声を並行取得する場合は別入力を使用します。
入力全体のsignalと、読み取りごとのsignalは寿命が異なります。
Mediabunnyは内部の終了管理アダプターが依存する1.61.0へ完全固定し、アプリ側のoverrideで変更しないでください。

### 確認済み範囲と後続機能

Linux Chromiumで回帰54件と30分の出力を確認済み。Windows Chrome／Edgeは未検証です。
AAC出力はWASM拡張、WebGLはSwiftShaderの測定結果です。
[検証結果](docs/VALIDATION_0.2.md) と [API契約](docs/API.md) を参照してください。
区間リサンプリング、パケット時刻API、AudioData直接入力は後続の検討範囲です。

## 0.1.0

MP4/M4A・MP3・WAVの情報取得、区間デコード、H.264 MP4出力、AAC拡張、独立したMP3出力を実装。
評価用アプリFramecraft、PlaywrightとFFmpegによる入出力検証を追加しました。
