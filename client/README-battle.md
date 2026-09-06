# 墨圈猎场 · 同图对战 v2（client）

## 文件

- `battle.html` 同图对战前端（匹配 / 权威 `world.snapshot` / 本地预览 fallback）
- `mock-server.mjs` 轻量 WS mock（默认 **8787**）
- `index.html` 单机 Demo（保留）

## 默认 WebSocket

`battle.html` 默认连接 **`ws://127.0.0.1:8788`**（对接旁路 `server-v2`）。

```
?ws=ws://127.0.0.1:8788   # 显式（与默认相同）
?ws=ws://127.0.0.1:8787   # 改连 client mock
?name=红方猎人
?local=1                  # 进页即本地同图预览
```

勿再依赖「仅 `location.host`」作为默认 WS。

## 联调（推荐 server-v2 @8788）

1. 确认后端监听 `ws://127.0.0.1:8788`
2. 托管 client：
   ```bash
   cd client && python3 -m http.server 5173
   ```
3. 两标签打开 `http://127.0.0.1:5173/battle.html`
4. 「开始匹配」→ `room.start`（`mode:shared_map` + `team`）→ 收 `world.snapshot`
5. WASD/摇杆上报 `input.move`；封圈上报 `input.loop`（仅己方怪可杀）

## 本地同图预览

大厅「本地同图预览」或 `?local=1`：无需 WS，双实体同屏、阵营色、无迷雾。

## 协议

以 `/workspace/墨圈猎场/WS协议-同图对战-v2.md` 为准（节点2：同图可见闭环）。
