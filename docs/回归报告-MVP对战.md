# 墨圈猎场 · 对战 MVP 回归报告

测试：牛马--测试  
时间：2026-09-06（Asia/Shanghai）  
清单：双人验收清单-MVP对战.md  
结论：**整包通过**（策划确认 §9 Pass；本地 §1–8 此前已过）

## 环境

| 项 | 值 |
|---|---|
| 本地静态 | http://127.0.0.1:5173/battle.html |
| 本地 WS | ws://127.0.0.1:8787 |
| 公网（最终） | https://told-jason-namespace-sampling.trycloudflare.com/battle |
| 公网 WSS | 同域 wss://told-jason-namespace-sampling.trycloudflare.com |
| 已弃用 | loca.lt 双隧道、violet-lamps-refuse.loca.lt |

协议脚本：server/scripts/smoke-node3-4.mjs（本地）、server/scripts/smoke-public.mjs（公网）

## 验收勾选（PRD §9）

| ID | 项 | 结果 | 证据摘要 |
|---|---|---|---|
| §1 | 两人自动匹配进局 | Pass | 本地双开 UI；本地/公网协议 match.found+room.start；策划确认公网 §9 |
| §2 | 本底怪 vs Demo | Pass | 干净双开局内可见多只本底怪；公网 UI 同玩法 |
| §3 | 塞敌同种立刻 | Pass | A kill → B combat.inject 同种（本地+公网协议） |
| §4 | 先到 K 结算 | Pass | smoke-match.mjs 打到 K 出 room.end（本地） |
| §5 | 5s 复活 / 对手不停 | Pass | down→revive ~5.0s；倒地期间对手可杀可塞 |
| §6 | 三选一对齐 Demo | Pass | 升级池 8 项与 Demo 完全一致；meta.levelup 回显 |
| §7 | 反滚雪球 | Pass | 本地：冷却 deny、帽后 drop_oldest、落后 speedMul=1.15 |
| §8 | 广告占位 | Pass | 复活/结算位可见；点击 toast「广告占位（未接 SDK）」 |
| §9 | 可访问 H5 | Pass | Cloudflare 公网可开；双连/匹配路径策划确认 Pass |

## 过程纪要

1. 本地节点 2–4：协议冒烟全绿；UI 双开验证匹配/本底怪/广告占位。
2. 公网 loca.lt：隧道 408/502，双开不稳 → 打回（已弃用）。
3. violet-lamps：偶发 502；协议重试可 PASS，UI 不稳 → 暂停后换链。
4. Cloudflare 稳链：页面 200；协议 §1/3/5/6 稳定 Pass；策划拍板 §9 Pass，整包通过。

## 已知注意

- loca.lt 类临时隧道不适合作为正式验收链路。
- 公网协议 §7 曾在并发/首跑出现超时偶发；本地 §7 稳定 Pass。以本地对照 + 策划公网体验为准。
- TBD 数值（N/K/冷却/上限/落后补偿）仍为临时默认，测后可调。

## 交付物

- 验收清单：/workspace/墨圈猎场/双人验收清单-MVP对战.md
- 本报告：/workspace/墨圈猎场/回归报告-MVP对战.md
- 冒烟脚本：server/scripts/smoke-node3-4.mjs、server/scripts/smoke-public.mjs
