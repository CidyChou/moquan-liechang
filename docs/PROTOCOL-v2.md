# 墨圈猎场 · 同图对战 v2 协议增量

状态：草约 v2.0（2026-09-07）
仓库：https://github.com/CidyChou/moquan-liechang
基线：v1 `/workspace/墨圈猎场/WS协议-对战.md`；本文只写同图变更。前端以本文为准覆盖分图逻辑。

## 0. 配置默认（沿用 v1 + 新增）

| key | 默认 | 说明 |
|---|---|---|
| livesN | 1 | 单命；归零倒地 |
| killTargetK | 30 | 先到者胜 |
| injectCooldownMs | 300 | 塞敌冷却 |
| injectExtraCap | 20 | 额外怪上限 |
| lagDiff | 8 | 落后补偿分差 |
| lagSpeedBonus | 0.15 | 落后移速加成 |
| reviveMs | 5000 | 复活倒计时 |
| levelupTimeoutMs | 8000 | 升级三选一超时，服务端随机落选 |
| tickHz | 20 | 权威 tick |
| teams | red/blue | 匹配成功随机分配 |

敌人类型仍：`drifter` | `swift` | `watcher`（强弱靠样式，不靠颜色）。

## 1. 匹配与开局（增量）

`match.found` / `room.start` 增加阵营与同图标记：

```json
{
  "type": "room.start",
  "roomId": "r_xxx",
  "mode": "shared_map",
  "you": { "playerId": "p_a", "slot": 0, "team": "red", "lives": 1, "kills": 0 },
  "opponent": { "playerId": "p_b", "slot": 1, "team": "blue", "lives": 1, "kills": 0 },
  "config": { "livesN": 1, "killTargetK": 30, "levelupTimeoutMs": 8000 },
  "seed": 123456789,
  "serverTime": 1730000000000
}
```

`team`：`"red"` | `"blue"`，双方不同；随机。
`mode` 固定 `"shared_map"`。

## 2. 同图权威状态（节点2优先）

服务端持有共享世界；按 tick 广播快照（可增量，首版全量也可）：

```json
{
  "type": "world.snapshot",
  "seq": 42,
  "serverTime": 1730000000100,
  "paused": false,
  "pauseReason": null,
  "players": [
    { "playerId": "p_a", "team": "red", "x": 100, "y": 200, "vx": 0, "vy": 0, "alive": true, "lives": 1, "kills": 3, "speedMul": 1, "reviveAt": null },
    { "playerId": "p_b", "team": "blue", "x": 400, "y": 220, "vx": 0, "vy": 0, "alive": true, "lives": 1, "kills": 1, "speedMul": 1.15, "reviveAt": null }
  ],
  "enemies": [
    { "id": "e_1", "ownerId": "p_a", "team": "red", "enemyType": "drifter", "x": 120, "y": 180, "hp": 1 }
  ]
}
```

- 无迷雾：双方收同一世界（或等价信息）。
- `ownerId`/`team`：怪归属；只打主人，不打对面玩家/怪。
- 玩家输入（移动/画圈）上报，服务端裁决。

客户端上报（建议）：

```json
{ "type": "input.move", "x": 1, "y": 0, "seq": 10 }
{ "type": "input.loop", "points": [[x,y],...], "seq": 11 }
```

`input.loop`：仅当圈内己方怪可击杀；对面怪忽略。

击杀成功服务端：
1. 击杀方 `kills++`；删己方该怪
2. 尝试塞敌：对面 `ownerId=对手` 同种 +1（冷却/上限同 v1）
3. 推 `combat.kill_ack` / 快照；先到 K → `room.end`

```json
{ "type": "combat.kill_ack", "killerId": "p_a", "enemyId": "e_1", "enemyType": "drifter", "kills": 4 }
{ "type": "combat.inject", "enemyType": "drifter", "to": "p_b", "ownerId": "p_b", "team": "blue", "injectId": "inj_xxx", "x": 0, "y": 0 }
```

## 3. 生命 / 复活

`combat.hit` → lives 归零 → `combat.down` + `reviveAt`；5s 后 `combat.revive`（lives=1）。倒地期间对手不暂停。

## 4. 升级双方暂停

任一方触发升级（如经验达标，具体触发可由服务端或经校验的客户端事件）：

```json
{
  "type": "levelup.offer",
  "forPlayerId": "p_a",
  "options": [
    { "id": "hp", "label": "生命", "desc": "短描述" },
    { "id": "spd", "label": "速度", "desc": "短描述" },
    { "id": "dmg", "label": "伤害", "desc": "短描述" }
  ],
  "deadline": 1730000008000,
  "timeoutMs": 8000
}
{ "type": "world.pause", "reason": "levelup", "forPlayerId": "p_a", "deadline": 1730000008000 }
```

未升级方只见等待，不展示对方三张卡（前端用 `forPlayerId` 区分）。

客户端：
`{ "type": "levelup.pick", "optionId": "spd" }`

超时未选：服务端随机落选并：
`{ "type": "levelup.resolved", "forPlayerId": "p_a", "optionId": "spd", "auto": true }`
`{ "type": "world.resume" }`

## 5. 节点2「同图可见」最小闭环

1. hello / match / room.start（含 team、mode=shared_map）
2. 双方收 world.snapshot（见对手+双方怪）
3. input.move 反映到快照
4. 比分/阵营字段正确

击杀归属、复活、升级暂停可同仓后续节点接。

## 6. 相对 v1 废弃

- 分图、本底怪纯前端权威
- 各自独立实体不同步
- livesN=3 多命（改为 1）
