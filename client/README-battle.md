# 墨圈猎场 1v1 对战 (节点2)

基于单机 Demo 的对战 H5 + 本地 WebSocket mock。

## 文件

- battle.html 对战前端
- mock-server.mjs Node WS mock
- index.html 单机 Demo（保留）
- package.json 依赖 ws

## 启动

cd /workspace/ink-hunt
npm install
node mock-server.mjs
# ws://127.0.0.1:8787

另开终端:
cd /workspace/ink-hunt
python3 -m http.server 5173

打开 http://127.0.0.1:5173/battle.html
可用 ?ws=ws://host:8787 覆盖

## 双开联调

1. mock 运行中
2. 两标签打开 battle.html
3. 两边点「开始匹配」配对进局
4. 各自击杀，顶中比分同步，先到 30 结算
5. 单人约 15s 超时回大厅 toast「暂时没人，稍后再试」

协议: /workspace/墨圈猎场/WS协议-对战.md
