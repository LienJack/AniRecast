# anirecast-py

AniRecast 的 Python sidecar。daemon 以子程序呼叫，用 JSON 交換輸入輸出：

- 分鏡偵測：PySceneDetect `AdaptiveDetector`
- 動漫角色偵測：imgutils 頭部與人物偵測
- 同一人識別：CCIP 特徵與帶約束的分群

環境由 uv 管理（Python 3.12）。onnxruntime 必須在 `pyproject.toml` 明確宣告，否則 imgutils 會在執行時嘗試用 pip 安裝而失敗。

```sh
uv sync --project python
uv run --project python anirecast-py --help
```
