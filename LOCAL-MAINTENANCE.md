# 本地维护说明：codex-host-pi-local

> 本机自用分支的维护记录，供 Agent 升级 codexhost 时照做。只用 Pi，其他 Harness 不维护。不进上游 PR。

## 布局

- 仓库：`C:/Users/Su/src/codex-host-pi-local`。`origin` 是上游 `BytePioneer-AI/codex-host`，`fork` 是 `kunkun9527/codex-host`。
- 当前分支：`pi-local-0.14.0`，基于上游 tag `v0.14.0`，跟踪 `fork/pi-local-0.14.0`。本地修改都是这条分支上 `v0.14.0..HEAD` 的提交，git 提交本身就是补丁，不另存 patch 文件。
- 安装目录：`%LOCALAPPDATA%/Programs/codexhost/app/`，版本看其中 `codexhost-distribution.json` 的 `version`。

## 本地提交

用 `git log --oneline v<版本>..HEAD` 查看。截至 v0.14.0：

| 提交 | 内容 | 部署到 |
|---|---|---|
| `78a62a3e` | 取消手动压缩时不再让 Session 故障 | Pi 插件 |
| `4019a274` | 子代理卡片在回执先于快照时也显示；恢复会话文件拥有的卡片 | Pi 插件 |
| `6232df9e` | 自主回合实时显示、handled prompt、回合跨不稳定 settle 保持打开 | Pi 插件 |
| `acbd67e5` | 运行中 single 子代理按唯一 step 读取 | Pi 插件 |
| `6cbd41f4`、`84f14d52` | Composer 里的工具问答卡（`request_user_input`）不被当成发送按钮 | renderer |
| `36f4abc1` | 运行中原生 `steer` 同轮插入；大 JSONL 帧线性缓冲；超时命令的迟到回复不再让 Session 故障 | Pi 插件 |
| `f768822b` | Pi 检测结果跨 Host 运行持久缓存，启动时不起 Pi 进程，30 秒后重检 | Pi 插件 |

每个提交的设计说明在提交信息和 `docs/harnesses/pi/`（`pi-steer.md`、`pi-inspection-cache.md` 等）。

## 部署哪些文件

| 构建产物 | 安装位置 |
|---|---|
| `packages/host-runtime/dist/plugins/pi/plugin.mjs`（`npm run build:typescript`） | `app/plugins/pi/plugin.mjs` |
| `packages/renderer-extension/dist/production.js`（`npm run build:renderer`） | `app/renderer-extension.js` |

覆盖前先备份为 `<文件>.bak-<上一个本地提交短哈希>`。

## 安装目录里的手改项（升级会被覆盖）

- `app/plugins/enabled.json` 只启用 `["pi", "codex-usage"]`（`codex-usage` 是 Codex 用量统计，不是 Harness）。原文件备份为 `enabled.json.bak-all`。少启用插件能减少 Host 启动时的检测请求。

## 升级 codexhost 的步骤

1. 用户先装好新版。读 `app/codexhost-distribution.json` 得到新版本 `<新>`。
2. `git fetch origin --tags`，`git switch -c pi-local-<新> v<新>`。
3. 按顺序 `git cherry-pick` 旧分支 `v<旧>..pi-local-<旧>` 的提交（含本文件的提交）。上游已修的问题跳过对应提交，冲突时以上游新代码为准重写本地修改，并更新上表。
4. `npm ci`；跑 `npx vitest run packages/adapters/pi packages/renderer-extension`，再对改动文件跑 `npx eslint`、`npx prettier --check`、`npx tsc -b`。
5. `npm run build:typescript && npm run build:renderer`，按「部署哪些文件」备份并覆盖；用 `cmp` 确认安装文件与产物一致，`node --input-type=module -e "await import('./plugin.mjs')"`（在 `app/plugins/pi/` 下）确认能加载。
6. 重新改 `app/plugins/enabled.json`（见上节）。
7. 让用户重启 codexhost 和 Codex 桌面端，再验证（见下节）。
8. `git push -u fork pi-local-<新>`。

## 验证

- Desktop 日志：`%LOCALAPPDATA%/Codex/Logs/<年>/<月>/<日>/codex-desktop-*-t0-*.log` 的 `response_routed` 行带 `method=` 与 `durationMs=`。重启后打开 Pi 会话，`thread/read`、`thread/turns/list`、`thread/resume` 应在几秒内；`codexhost/harness/inspect` 在缓存命中时应为毫秒级。
- Host 日志：`~/.codexhost/logs/host-runtime-*.log`，搜 `Harness Session faulted`，不应出现 `Pi RPC response id is not pending`。
- 实机：任务运行中强行发送（引导），消息应在同一轮送达，不卡、不报 `Pi Session is not open`。

## Pi 扩展的启动开销（不在本仓库，但影响打开会话）

`~/.pi/agent/local-packages/` 下的本地扩展包，如果在包目录里跑过普通 `npm install`，会把开发依赖和 peer 依赖里的整份 `@earendil-works/pi-*` 装进各自的 `node_modules`。Pi 运行时会加载这些私有副本，每个包多花 1–2 秒启动。开发完在包目录执行 `npm prune --omit=dev --omit=peer --legacy-peer-deps`，并用 `git checkout package-lock.json` 还原被改的锁文件。检查：`ls ~/.pi/agent/local-packages/*/node_modules/@earendil-works` 应为空。
