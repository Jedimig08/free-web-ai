### 🐛 Fixes

- **DeepSeek**: the model's thinking/reasoning span no longer appears in `content` — it is routed to `reasoning_content` / `reasoning` / `thinking` only (covers the new `THINK`/`RESPONSE` fragment stream, bare `{"v":…}` deltas and repeated snapshots)

### 🔧 Other Changes

- `deepseek-chat` + `deepseek-reasoner` merged into a single **`deepseek`** model (legacy ids still resolve)
- `deepseek` streams reasoning-first, like other reasoning models
- Biome format/lint cleanup across the repo
- npm publishing is skipped gracefully when `NPM_TOKEN` is missing
- New tests: DeepSeek parser covered with a verbatim capture of the real stream
