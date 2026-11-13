# 0.7.0の映像コピー検証

検証日: 2026-11-13。0.6.1開発版のZoom対応を含みます。
Windows、Chrome 157.0.8103.50、Edge 157.0.4341.42。
追加依存なし。MediabunnyとAAC拡張は1.61.0のままです。

## 実行と結果

- `npm test`: 型検査、Web 90件、Framecraft 6件、SPS gap回帰、既存映像コピー統合、新規強行コピー統合が成功。
- `node scripts/test-video-copy-container.mjs`: Chrome／Edgeのfile://で成功。オフライン、外部通信0、pageerror 0。
- 同スクリプトの`--https`: ChromeのローカルHTTPSで成功。外部通信0、pageerror 0。
- publicバンドルをBlob Workerへ読み込み、強行モードの計画・出力が成功。
- 通常scriptサンプルで通常モードの拒否→強行モードの選択→計画→Blob出力→通常へ戻して計画破棄を確認。日本語／英語、デスクトップ／390px画面を確認。
- Browser plugin not available。ブラウザ試験はPlaywrightを使用。

Closed GOP／Open GOPの合成入力は160×96、25fps、8秒、Bフレームあり。
保持区間は[1,3)、[4,8)、計画時間は6秒。

| ケース | 結果 |
|---|---|
| Closed GOP、強行 | 150パケット、省略0・時間調整0。圧縮ペイロード・PTS・独立デコード画像が一致 |
| Open GOP、通常 | `SYNC_IDR_MISMATCH`、`recoverableInContainer:true`で停止 |
| Open GOP、強行 | 148パケット、省略1・時間調整2。定義した復号範囲と表示時刻条件から算出したペイロード・PTS・6秒の時間が一致 |
| gap許可＋実際の番号不連続 | 通常は停止、強行は`FRAME_NUMBER_DISCONTINUITY`を返して100パケット出力 |
| 警告後のSPS／PPS変更・壊れたNAL | 強行でも停止。検査器の無効化がないことを確認 |
| sample description変更・ゼロ時間 | 強行でも停止 |
| コピー／別セッションの計画 | `PLAN_MISMATCH` |
| Blob上限・キャンセル | 停止、ストリームabort・ロック解放、その後の再試行成功 |
| 加工PCM＋Open GOP強行 | 48kHz・2ch・AAC 80kbps、288000サンプル、3つの音声パルス位置が許容差25ms以内。PCM不足は停止 |

Open GOP出力のFFmpeg独立デコードは終了しましたが、`mmco: unref short failure`と
デコード後の時刻に関する警告が発生しました。圧縮パケットのコピー成功を、参照関係の修復や
全フレームの再生品質の保証とは扱いません。これらの問題を許容して保存するための明示設定です。

## Zoom実録画

提供された81分26秒・1080pのMP4を、Chromeのfile://で強行モードでも全解析。
122150パケットを確認し、先頭・中間・末尾の3区間を合計197.68秒へ連結しました。
出力4942映像パケット、PCM 9488640サンプル、音量0.5倍、AAC 80kbps、位置指定ストリーム保存。
省略・時間調整は0件、警告は強行モードの使用通知だけでした。

全出力映像ペイロード・PTS、各区間の先頭／中央／末尾の9箇所の復号画像が元入力と一致。
有音の2箇所の相関は0.996以上、実測音量比は0.499～0.500。残り1箇所は無音で相関評価対象外。
通常モードの全長コピーと約79分の加工音声付き出力の詳細は[0.6.1検証](VALIDATION_0.6.1.md)。
入力・出力メディアと私的な詳細レポートは配布物に含めません。

## 再現

`npm run test:video-copy`で合成素材から検証できます。生成物は`tests/tmp/video-copy-container/`。
Chrome／Edge／HTTPS別のJSON、独立デコーダーのログ、画面キャプチャを保存します。
実素材試験は`node scripts/test-video-copy-zoom.mjs <入力MP4> --short --container`。
入力を読み取り専用で扱い、生成物は`tests/tmp/zoom-copy-*-short-container/`へ保存します。
対応範囲と診断コードは[API仕様](VIDEO_COPY.md)を参照してください。
