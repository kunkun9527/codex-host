# Pi 同轮插入

Pi 的运行中插入走 RPC `steer` 命令（`{ type: "steer", message }`）。它不取消当前 Turn，也不另开一轮；Pi 把输入放进 steering 队列，响应 `disposition: "queued"`（扩展输入处理器吞掉时为 `"handled"`），随后由 Pi 自己送达。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。

## 为什么能并入当前 Turn

依据 `@earendil-works/pi-coding-agent` 1.4.0 与 `pi-agent-core` 的实现：

- `agent-loop` 在**每次**助手回复结束（`turn_end`）后都会轮询 steering 队列，有排队输入就继续下一次模型请求；这和是否有工具调用无关，所以最终文本阶段插入也会在本次运行内送达。
- 运行结束后，`AgentSession._startRun` 在 `_handlePostAgentRun` 与 `_runBeforeSettleBoundary` 中检查 `hasQueuedMessages()`，有排队输入就 `agent.continue()`，直到队列为空才发 `agent_settled`。
- `PiRpcSession` 以 `agent_settled` 加 `get_state` 确认作为 Turn 终结，因此 settle 之前收下的插入都属于当前 Host Turn。

唯一的缝隙是最后一次队列检查之后、`agent_settled` 之前（扩展的 `agent_settled` 处理期间）收下的插入：它会留在队列里，等到下一次 prompt。`PiRpcSession` 在确认 settle 时读取 `get_state.pendingMessageCount`；本轮插过队且队列非空时，先 `clear_queue` 取出排队文本，未取消就以 `prompt` 在同一个 Host Turn 里重新发起（其余 follow-up 用 `follow_up` 跟上）；已取消则只清空队列，不让它漏进下一轮。

## 何时声明能力

`capabilities.steer` 实时取以下条件的交集，任何一项不满足都为 `false`，Host 改用停止后重发：

- Session 处于 open，Adapter 有用户发起的活跃 Turn，且尚未请求取消；
- `PiRpcSession` 的活跃 Turn 是 `requested`（不是自主 Turn），已经观察到运行活动（`agent_start`、助手消息或工具开始；被扩展命令 `handled` 的 prompt 没有运行，不能插入），settle 尚未开始确认，也没有取消。

`turn.steer` 在写入前同步复查这些条件。Pi 以 `success: false` 拒绝（例如扩展命令不能排队）或条件不满足时返回 `invalidState`，表示输入没被收下，Host 可以停止后重发；写入后超时或 Session 故障则抛出，Host 不自动重发。空文本返回 `invalidRequest`。

## 历史

Pi 把插入记成 Session 文件中一条普通的 `role: "user"` 消息，所以刷新后的历史会在插入点多分出一个原生 Turn。`#completedTurnIdentity` 已按“本轮新增的第一个原生 Turn 作身份、最后一个作 Checkpoint”处理多轮，Host 端由 `steeredTurnIds` 约束 Fork 与撤销，见 [外部 Thread 的「调整方向」](../../architecture/external-thread-steering.md)。

## 验证

- `packages/adapters/pi/test/pi-rpc-session.test.ts`：工具执行中插入并在同一 Turn 得到回复；错过最后一次队列检查的插入经 `clear_queue` + `prompt` 仍在同一 Turn 送达；Pi 拒绝插入时不 fault、仍可插入。
- `packages/adapters/pi/test/pi-adapter.test.ts`：能力随活跃运行变化、目标 Turn 校验、Pi 拒绝映射为 `invalidState`、取消后不再声明。

未在真实 Pi 进程上实机验证插入时序；上面的结论来自对安装版源码的阅读和合成 RPC 测试。
