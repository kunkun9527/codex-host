# Pi 检测结果持久缓存

Pi 的 `inspect()` 要起一个完整的 Pi RPC 进程（加载全部 Pi 扩展）读 Model 目录和能力，单次 2–3 秒。Host 启动时 Desktop 会同时发几次检测，正好又在打开会话，几个 Pi 进程互相抢 CPU 和磁盘，每个都拖到 7–8 秒，打开会话也被拖慢。

## 行为

- 检测成功（`status: "ready"`）的结果按 inspect cwd 写入 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/cache/pi-inspection-v1.json`（`plugin.ts` 传入 `inspectionCacheFile`）。
- 内存里没有、文件里有时，直接返回文件里的结果，不起 Pi 进程；同时安排一次延迟重检（默认 30 秒，`inspectionRevalidateDelayMs`），避开启动高峰。重检成功覆盖内存和文件。
- 重检或任何一次检测失败时删掉文件里的该 cwd 条目，下次 Host 启动重新真实检测；本次运行的内存缓存沿用原有语义（失败不清掉已有的成功结果）。
- `refresh: true`（设置页「重新检测」）绕过文件缓存。凭据导入、重导入、移除同时清空内存和文件缓存。
- 文件缺失、损坏或条目不通过 `harnessInspectionSchema` 校验时按空缓存处理，不报错。
- 不传 `inspectionCacheFile`（测试、直接构造 Adapter）时只用内存缓存，行为与以前相同。

## 打开会话时只完整读一次历史

恢复会话时，`open()` 已经为用量统计读过一次完整的 `get_entries`。Session 留住这份历史，第一次 `readSnapshot()` 只用 `get_entries { since: <最后一条 Entry id> }` 取之后追加的条目再拼上，不再让 Pi 整份回传一次（2.4 MB 的会话约省 0.7 秒，越大越多）。Pi 的 Entry 只追加，所以拼出的就是完整历史。

- 只用一次：第一次快照读取后、任意 Host 命令（`execute`）或关闭时丢弃，不长期占内存。
- 换了 transport、`since` 指向的条目不存在（Pi 报 `Entry not found`，命令错误不会让 Session 故障），或 transport 不支持 `getEntriesSince` 时，退回完整读取。

## 代价

新增或删除 Pi 的 Provider/Model 后，Host 重启后的头 30 秒左右模型列表可能还是上次的，重检完成后更新；需要立即生效时用「重新检测」。
