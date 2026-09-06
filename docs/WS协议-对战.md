# 墨圈猎场 · 对战 WS 协议草约（后端权威）

状态：草约 v0.1（2026-09-06）  
服务：Node.js WebSocket  
默认：`ws://<host>:8787`（部署后以运维为准；本地可改）  
编码：文本 JSON，一行一帧；字段未特别说明均为必填。

## 0. 可配置默认（服务端 config，可环境变量覆盖）

| key | 默认 | 说明 |
|---|---|---|
| `livesN` | 3 | 开局命数 |
| `killTargetK` | 30 | 先到者胜 |
| `injectCooldownMs` | 300 | 塞敌最短间隔 |
| `injectExtraCap` | 20 | 对手本底外额外怪上限 |
| `injectOverflow` | `"drop_oldest"` | 超限策略：`drop_oldest` \| `queue` \| `reject` |
| `lagDiff` | 8 | 分差≥此值触发落后补偿 |
| `lagSpeedBonus` | 0.15 | 落后方移速 +15% |
| `reviveMs` | 5000 | 命尽后自动复活 |
| `heartbeatTimeoutMs` | 30000 | 无心跳判负 |
| `matchTimeoutMs` | 15000 | 匹配超时回大厅 |
| `tickHz` | 20 | 房间权威 tick（仅服务端计时器用） |

敌人类型对齐单机 Demo：`drifter` \| `swift` \| `watcher`。

---

## 1. 连接与身份

客户端连接后立刻发：

```json
{ "type": "hello", "playerName": "可选昵称", "clientVersion": "0.1" }
```

服务端：

```json
{ "type": "welcome", "playerId": "p_xxx", "config": { "livesN": 3, "killTargetK": 30, "injectCooldownMs": 300, "injectExtraCap": 20, "lagDiff": 8, "lagSpeedBonus": 0.15, "reviveMs": 5000, "heartbeatTimeoutMs": 30000, "matchTimeoutMs": 15000 } }
```

心跳（双向；客户端至少每 10s 发一次）：

```json
{ "type": "ping", "t": 1730000000000 }
{ "type": "pong", "t": 1730000000000 }
```

---

## 2. 匹配

客户端：

```json
{ "type": "match.join" }
{ "type": "match.cancel" }
```

服务端：

```json
{ "type": "match.queued", "timeoutMs": 15000 }
{ "type": "match.timeout" }
{ "type": "match.found", "roomId": "r_xxx", "you": "p_a", "opponent": { "playerId": "p_b", "playerName": "…" }, "seed": 123456789 }
```

`seed`：双方本底刷怪可用同一 RNG 种子（画面仍各自独立，仅便于复现/调试）。

---

## 3. 房间状态机

`lobby` → `matching` → `playing` → `ended`

开局（匹配成功后立刻）：

```json
{
  "type": "room.start",
  "roomId": "r_xxx",
  "you": { "playerId": "p_a", "slot": 0, "lives": 3, "kills": 0 },
  "opponent": { "playerId": "p_b", "slot": 1, "lives": 3, "kills": 0 },
  "config": { "livesN": 3, "killTargetK": 30 },
  "serverTime": 1730000000000
}
```

比分快照（击杀/命/补偿变化后推双方）：

```json
{
  "type": "room.score",
  "you": { "kills": 12, "lives": 2, "alive": true, "reviveAt": null, "speedMul": 1 },
  "opponent": { "kills": 20, "lives": 3, "alive": true, "reviveAt": null, "speedMul": 1.15 },
  "lagBonusOn": "you"
}
```

`speedMul`：服务端权威（落后补偿）；前端用此乘本地移速。`lagBonusOn`：`"you"` \| `"opponent"` \| `null`。

结算：

```json
{
  "type": "room.end",
  "reason": "kill_target",
  "winnerId": "p_a",
  "you": { "kills": 30, "lives": 1 },
  "opponent": { "kills": 22, "lives": 2 }
}
```

`reason`：`kill_target` \| `opponent_disconnect` \| `you_disconnect`（本端被判负时也可能收到）。

---

## 4. 权威事件（客户端上报 → 服务端裁决 → 广播）

### 4.1 击杀（驱动塞敌）

客户端（仅自己地图击杀）：

```json
{ "type": "combat.kill", "enemyType": "drifter", "enemyId": "可选本地id", "seq": 1 }
```

服务端校验通过后：

1. 击杀方 `kills++`；若 `kills >= K` → `room.end`
2. 按冷却/上限尝试向对手塞敌
3. 推 `room.score`；若塞敌成功再推：

```json
{ "type": "combat.inject", "enemyType": "drifter", "to": "p_b", "injectId": "inj_xxx", "queued": false }
```

仅 `to` 对应客户端本地生成该怪；`queued:true` 表示进排队未立刻出场（overflow=`queue` 时）。

冷却未到 / 达上限被拒时：

```json
{ "type": "combat.inject_denied", "enemyType": "drifter", "reason": "cooldown" }
```

`reason`：`cooldown` \| `cap` \| `reject`。击杀仍计入。

### 4.2 受击扣命

客户端：

```json
{ "type": "combat.hit", "damageLives": 1, "seq": 2 }
```

服务端：`lives` 减少；`lives<=0` → `alive=false`，`reviveAt = now+reviveMs`，推 `room.score`，并：

```json
{ "type": "combat.down", "playerId": "p_a", "reviveAt": 1730000005000 }
```

倒计时结束后服务端自动：

```json
{ "type": "combat.revive", "playerId": "p_a", "lives": 3 }
```

期间对手不停；击杀仍可导致胜负。本版复活免费、不限次；广告仅前端占位。

### 4.3 升级三选一（玩法在前端，服务端只记账可选）

MVP 服务端可不裁决选项内容；前端本地结算即可。若需防作弊后续再加。预留：

```json
{ "type": "meta.levelup", "level": 3, "choiceId": "可选" }
```

服务端可忽略或 echo。

---

## 5. 节点 2「可匹配可打」最小闭环

必须可用：

1. `hello` / `welcome`
2. `match.join` → `match.found` → `room.start`
3. `combat.kill` → `room.score`（双方可见比分）
4. `ping`/`pong`；超时 `room.end reason=opponent_disconnect`
5. `match.timeout`

塞敌 / 复活 / 落后补偿按 §4 实现，可与节点 2 同仓落地，前端可分阶段接入。

---

## 6. 错误

```json
{ "type": "error", "code": "not_in_room", "message": "…" }
```

常见 `code`：`bad_payload` \| `not_in_queue` \| `not_in_room` \| `already_matched` \| `room_ended`。

---

## 7. 实现备注（给前后端）

- **权威**：击杀数、命、复活时刻、塞敌是否成功、胜负、speedMul 均以服务端为准；客户端预测可做，冲突以 `room.score` 校正。
- **视野**：不同步对方实体；只同步比分与塞敌指令。
- **本底怪**：仍由各自前端按 Demo 规则刷；塞敌是额外叠加。
- **联调**：可用两个浏览器标签连同一 `ws` 自测匹配。
