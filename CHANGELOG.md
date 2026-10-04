# 変更履歴

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
