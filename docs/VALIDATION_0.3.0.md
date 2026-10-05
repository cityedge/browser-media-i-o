# 0.3.0 通常script版の検証

2026-10-05、WindowsのChrome 154.0.8037.93 / Edge 154.0.4258.37で実施。
通常script版ライブラリを同梱の小さな利用アプリから読み込み、file://で検証します。

| 項目 | 確認内容 |
|---|---|
| 起動 | ZIP展開先・入力名に日本語と空白を含め、初回からオフライン |
| 通信・エラー | 外部ネットワーク要求0、ページ／コンソールエラー0 |
| 入出力 | 画面からMP4選択 → MP4/MP3生成 → Blob保存 |
| MP4 | FFmpegで300フレームの番号・順序・時刻、左右の音声マーカーを照合 |
| AAC | Windowsネイティブと、能力応答だけを無効化した実WASMを別々に検証 |
| 公開API版 | 単独バンドルで読取中止後の再利用、MP4/PCM往復、MP3生成 |
| 異常系 | キャンセル後の再実行、壊れた入力後の旧保存リンク無効化 |
| 音声時刻 | 0.25秒の音声遅延を持つMP4のタイミング保持 |
| 表示 | 日英切替、1200×1000と390×844。モバイル実機試験ではない |
| 既存API | Web 59件＋Framecraft 6件、型検査 |

測定値: [Chrome](reports/file-launch/windows-chrome-0.3.0.json) /
[Edge](reports/file-launch/windows-edge-0.3.0.json)。
映像の最大時刻誤差は約0.333 µs。MP3は2ch・10.032秒。AACパディング込みの音声は480,256サンプル。
検証素材は10秒で、左音声マーカーは1/4/8秒、右は2/5/9秒です。

## 再現

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
npm run test:local
npm run check:distribution
```

test:localはHTTPサーバー・制限解除フラグを使いません。実際の軽量ZIPを展開して試験します。
ZIP内のSHA256SUMSも照合し、測定JSONには検証したZIP自身のSHA-256を記録します。
各実行の成果物はtests/tmp/local-<browser>/。過去の測定JSONのZIPハッシュは、その実行時の配布物に対応します。

## 未検証

Safari/Firefox/モバイル、長尺file://出力、直接ファイルストリーム保存。
サンプルの60秒・128 MiB制限はUIの設定です。ライブラリの固定上限ではありません。
[API契約](API.md)、[通常HTMLへの組み込み](LOCAL_DISTRIBUTION.md)も参照してください。
