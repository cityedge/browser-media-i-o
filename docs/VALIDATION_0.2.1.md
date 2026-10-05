# 0.2.1 公開API版の検証

既存の終了保証を持つルートAPIと、Mediabunnyの公開APIだけを使う `/public` を同じパッケージへ追加しました。
[契約の比較](API.md#入力apiの選択021) ／ [導入ガイド](GETTING_STARTED.md) ／ [0.2.0の評価記録](VALIDATION_0.2.md)。

## 確認したこと

`npm test`：ビルド・型検査、Web 59件、Framecraft 6件が成功。失敗・skip・flakyは0件です。
[全65件と測定データ](reports/v0.2.1/regression.json)、[Web集計](reports/v0.2.1/web-stats.json)、[アプリ集計](reports/v0.2.1/app-stats.json)。

- 既存APIの入力・出力・MP3・WebGL・アプリ操作を継続して検証。
- 両入力APIで、Bフレーム・可変fps・開始オフセット・表示空白・半開区間の境界をFFprobeの正解データと比較。
- 同一フレームの独立したclose、所有権、未解放フレーム上限、排他、エラー後の再利用、PCMのサンプル境界を確認。
- 公開API入口とAAC入口をまとめてbundleし、tree shakingを無効にしても従来の内部接続アダプターが依存グラフにないことを確認。
- 公開API版だけをimportするWindow／Dedicated Workerで、H.264＋AACの10秒動画を読み込み、情報取得・PCM取得・MP4出力を実行。
  両方とも300フレーム／480,000サンプルを出力し、FFmpeg／ffprobeでフレーム識別子・時刻・音声マーカーを検証。
- Worker内でのPCM読み取り中止から再利用までを確認。AudioBufferが存在しない環境で入出力が成立。

## 中止後の資源確認

VideoDecoder／AudioDecoderの作成とcloseをテストで追跡しました。初期化中・next待機中・yieldで停止中という
3種類の状態で中止し、同じ入力を使って次の読み取りへ進めます。入力全体をcloseする前に、6反復ごとに残存数を確認します。

| 入口・対象 | 中止反復数 | 作成デコーダー数 | 同時存在数の最大 | return直後の残存数の最大 | 待機後の残存数 |
|---|---:|---:|---:|---:|---:|
| 従来・映像 | 36 | 62 | 1 | 0 | 全6回で0 |
| 公開・映像 | 36 | 62 | 1 | 0 | 全6回で0 |
| 従来・AAC音声 | 18 | 30 | 1 | 0 | 全3回で0 |
| 公開・AAC音声 | 18 | 30 | 1 | 0 | 全3回で0 |

今回の素材・環境では公開API版でもreturn直後の残存を観測しませんでした。これは終了待ちの仕様保証ではありません。
テストでは残存数を最大5秒待って確認しますが、この時間はテストの失敗判定用で、APIの完了時間の保証ではありません。
追跡したのはブラウザに作成したデコーダーのcloseです。内部のパケット先読み・JSヒープ・実メモリの回収完了は測定していません。

## 環境と制限

- Linux Chromium 151.0.7922.173、Mediabunny 1.61.0、AAC出力はWASM拡張1.61.0。
- Windows Chrome／Edge、ネイティブAAC出力、実GPUでの性能は今回も未検証。
- 0.2.1では短尺の回帰試験を実施。30分試験は0.2.0の従来APIの記録であり、公開API版の長尺評価として扱いません。
- 高解像度・多数入力・遅い読み取り環境での反復中止について、無条件の資源上限や終了時間を保証しません。
- 公開API版であってもMediabunny本体への依存はあります。パッケージは従来APIとの共存のため1.61.0へ固定しています。

## 再現手順

```sh
npm ci
npm test
MEDIA_REPORT_DIR=docs/reports/v0.2.1 node scripts/collect-validation.mjs
# 対象部分だけ再実行する場合
npm run build
npx playwright test tests/web/streams.spec.ts tests/web/public.spec.ts
```

Windowsでの環境変数の指定方法と必要ツールは [従来の検証手順](VALIDATION_0.2.md) を参照してください。
