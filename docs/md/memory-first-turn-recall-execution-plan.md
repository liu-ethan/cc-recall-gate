# 首轮记忆召回优化 Coding Plan

> 目标读者：coding agent。本文只描述代码怎么改、Step 需求、边界、验收标准、必须通过的测试用例。

## 0. 改造目标

在每个 User Turn 内，基于当前用户请求做三路记忆召回策略：

```text
SYNC_RECALL  → 首次 callModel 前等待本 Turn 已启动的记忆预取，并注入 Top 1~2 个记忆
ASYNC_RECALL → 不阻塞首次 callModel，沿用现有工具执行后的异步消费路径
SKIP_RECALL  → 取消本 Turn 记忆预取，本轮不注入 relevant_memories
```

核心约束：

- 不新增向量库、不改 Auto Memory 写入、不改 Session Memory / Compact。
- 不新增写文件副作用；本优化只读 memory 文件并注入 attachment。
- 同一个 User Turn 内只能启动一次 relevant memory prefetch，SYNC 和 ASYNC 共享同一个 Promise。
- Gate 失败、超时、非法输出必须降级为 `ASYNC_RECALL`。
- 用户明确要求忽略历史记忆时必须走 `SKIP_RECALL`。

## 1. 现有代码锚点

优先复用现有能力，不重写召回系统。

| 文件 | 现状职责 | 本次改动 |
|---|---|---|
| `src/query.ts` | User Turn 主循环；启动 memory prefetch；构造 `messagesForQuery`；首次 `callModel`；工具后消费 prefetch | 接入 Gate；在首次 `callModel` 前处理 `SYNC_RECALL`；保留工具后 `ASYNC_RECALL` 消费 |
| `src/utils/attachments.ts` | `startRelevantMemoryPrefetch`、`MemoryPrefetch`、`filterDuplicateMemoryAttachments`、读 memory 文件与预算 | 扩展 prefetch handle：abort、skip、consume 状态；增加同步消费 helper |
| `src/memdir/findRelevantMemories.ts` | Sonnet 选择最多 5 个相关 memory | 可复用；首版不改 selector |
| `src/memdir/memoryScan.ts` | 扫描最多 200 个 memory frontmatter | Gate 需要 manifest 时优先复用这里 |

当前关键行为：

```text
src/query.ts
  startRelevantMemoryPrefetch(state.messages, state.toolUseContext)
    ↓
  while loop 内构造 messagesForQuery
    ↓
  deps.callModel({ messages: prependUserContext(messagesForQuery, userContext) })
    ↓
  工具执行后，如果 prefetch settled，再 filterDuplicateMemoryAttachments 后注入
```

问题点：如果首轮没有 Tool Call，prefetch 结果不会在本 Turn 被主模型看到。

## 2. Step 1：补齐 MemoryPrefetch 控制能力

### 需求

在 `src/utils/attachments.ts` 扩展 `MemoryPrefetch`，让 query 主循环能显式取消、跳过、同步消费。

建议类型：

```ts
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
  skipped: boolean
  abort(reason?: string): void
  [Symbol.dispose](): void
}
```

实现要求：

1. `startRelevantMemoryPrefetch` 内部已有 `createChildAbortController(toolUseContext.abortController)`，把该 controller 暴露为 `abort()` 方法。
2. `abort()` 要设置 `skipped = true`，并调用 controller.abort()。
3. `[Symbol.dispose]()` 继续负责兜底 abort 和 telemetry。
4. 已 `skipped` 的 prefetch，即使 promise 后续 resolve，也不能被消费。

### 边界

- `startRelevantMemoryPrefetch` 可能返回 `undefined`，调用方必须兼容。
- abort 后 promise 当前 catch 会返回 `[]`，这是允许的。
- 不要在 prefetch 阶段写 `readFileState`，仍然只在消费阶段写，避免自我去重。

### 验收标准

- `MemoryPrefetch` 有显式 `abort()` 和 `skipped` 状态。
- `SKIP_RECALL` 后不会在工具后消费该 prefetch。
- 原有异步路径行为不退化：未 skipped、已 settled、未 consumed 时仍可消费。

### 必测用例

1. `abort()` 被调用后，`skipped === true`。
2. `skipped === true` 时，即使 `promise` resolve 出 memory attachment，也不会注入。
3. dispose 时仍会 abort 未完成任务，不抛异常。

## 3. Step 2：新增 RecallPolicy / Gate

### 需求

新增一个轻量 Gate 模块，建议文件：

```text
src/memdir/recallPolicy.ts
```

导出：

```ts
export type RecallPolicy = 'SYNC_RECALL' | 'ASYNC_RECALL' | 'SKIP_RECALL'

export type RecallPolicyResult = {
  policy: RecallPolicy
  reason: string
  timedOut?: boolean
}

export async function decideRecallPolicy(args: {
  messages: readonly Message[]
  signal: AbortSignal
}): Promise<RecallPolicyResult>
```

首版实现建议：

1. 先做规则快判：
   - 用户明确说“不要参考之前 / 忽略记忆 / 不用历史 / forget previous memory”等，返回 `SKIP_RECALL`。
   - 用户明确说“还记得 / 之前说过 / 上次 / 按我之前 / remember / previously / last time”等，返回 `SYNC_RECALL`。
2. 其他请求返回 `ASYNC_RECALL`。
3. 后续如果接 sideQuery，也必须输出受约束枚举；非法输出降级 `ASYNC_RECALL`。

### 边界

- Gate 只决定是否等记忆，不负责选择 memory 文件，不负责回答用户问题。
- 负例必须保守：不能因为看起来是普通代码问题就轻易 `SKIP_RECALL`；默认 `ASYNC_RECALL`。
- Gate 只能读取当前真实 user message 和少量上下文；不要把 tool result 当成用户意图。
- Gate 失败、异常、超时统一返回 `ASYNC_RECALL`。

### 验收标准

- 返回值只可能是三种枚举。
- 显式忽略历史的请求走 `SKIP_RECALL`。
- 显式历史依赖请求走 `SYNC_RECALL`。
- 普通或不确定请求走 `ASYNC_RECALL`。

### 必测用例

1. `"不要参考我之前的偏好"` → `SKIP_RECALL`。
2. `"你还记得我之前说测试不要用 Mock 吗"` → `SYNC_RECALL`。
3. `"按上次那个方案继续"` → `SYNC_RECALL`。
4. `"帮我解释这个函数"` → `ASYNC_RECALL`。
5. Gate 抛错 / 超时 / 非法输出 → `ASYNC_RECALL`。

## 4. Step 3：在 query.ts 启动 Gate，并与 prefetch 并发

### 需求

在 `src/query.ts` 中，保持现有每 Turn 一次：

```ts
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

同时启动 Gate，不要先等 Gate 再启动 prefetch。

建议形态：

```ts
const pendingRecallPolicy = decideRecallPolicy({
  messages: state.messages,
  signal: state.toolUseContext.abortController.signal,
}).catch(() => ({
  policy: 'ASYNC_RECALL' as const,
  reason: 'gate_error',
}))
```

然后在首次 `callModel` 前 await Gate 结果。

### 边界

- 如果 `pendingMemoryPrefetch === undefined`，Gate 可运行，但 `SYNC_RECALL` 无 memory 可等；此时继续正常调用主模型。
- Gate await 点必须在首次 `callModel` 前，但不能放到每个 loop iteration 都重复执行。
- 用户中断时 Gate 必须收到 `toolUseContext.abortController.signal`。

### 验收标准

- prefetch 和 Gate 是并发启动，不是串行。
- 每个 User Turn 只启动一次 Gate。
- Gate 决策在首次 `callModel` 前可用。

### 必测用例

1. 构造慢 prefetch、快 Gate：确认 prefetch 在 Gate resolve 前已经启动。
2. 构造 Gate 抛错：主 loop 继续，策略为 `ASYNC_RECALL`。
3. 用户 abort：Gate 收到 abort signal。

## 5. Step 4：实现 SYNC_RECALL 首轮注入

### 需求

在 `src/query.ts` 首次调用：

```ts
deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  ...
})
```

之前，插入 `SYNC_RECALL` 处理逻辑。

建议新增 helper 到 `src/utils/attachments.ts`：

```ts
export async function consumeRelevantMemoryPrefetch(
  prefetch: MemoryPrefetch | undefined,
  readFileState: FileStateCache,
  iteration: number,
  options?: { limitMemories?: number }
): Promise<Attachment[]>
```

行为：

1. `prefetch === undefined` → `[]`。
2. `prefetch.skipped === true` → `[]`。
3. `prefetch.consumedOnIteration !== -1` → `[]`。
4. await `prefetch.promise`。
5. 调用 `filterDuplicateMemoryAttachments`。
6. 如果 `limitMemories = 2`，只保留 Top 1~2 个 memory。
7. 设置 `prefetch.consumedOnIteration = iteration`。

在 `query.ts`：

```text
policy = await pendingRecallPolicy
if policy == SYNC_RECALL:
  attachments = await consumeRelevantMemoryPrefetch(pendingMemoryPrefetch, readFileState, turnCount - 1, { limitMemories: 2 })
  messagesForQuery.push(...attachments.map(createAttachmentMessage))
if policy == SKIP_RECALL:
  pendingMemoryPrefetch?.abort('skip_recall')
if policy == ASYNC_RECALL:
  do nothing before first callModel
```

### 边界

- 只在本 Turn 第一次 `callModel` 前执行一次同步注入；后续 loop iteration 不重复执行首轮同步逻辑。
- `SYNC_RECALL` 等待的是同一个 `pendingMemoryPrefetch.promise`，不能再调用 `findRelevantMemories`。
- 注入后必须写 `readFileState`，避免后续工具后消费重复注入。
- 首轮最多注入 Top 1~2 个 memory；不要把最多 5 个全塞入首轮。
- 如果 promise 返回空数组，不要伪造 memory attachment。

### 验收标准

- 显式回忆请求中，第一次 `deps.callModel` 入参 messages 已包含 `relevant_memories` attachment。
- 同一个 memory 文件不会在工具后再次注入。
- `ASYNC_RECALL` 下第一次 `deps.callModel` 不等待 memory promise。
- `SKIP_RECALL` 下第一次 `deps.callModel` 不包含 memory attachment，后续也不包含。

### 必测用例

1. `SYNC_RECALL` + prefetch 返回 1 个 memory：首次 `callModel` messages 包含该 memory。
2. `SYNC_RECALL` + prefetch 返回 5 个 memory：首次最多注入 2 个。
3. `SYNC_RECALL` + prefetch 返回已在 `readFileState` 的 path：不注入。
4. `SYNC_RECALL` 注入后，工具后消费点不重复注入。
5. `ASYNC_RECALL` + 慢 prefetch：首次 `callModel` 不等待。
6. `SKIP_RECALL`：调用 `abort()`，首轮和工具后均不注入。

## 6. Step 5：保留并收敛 ASYNC 工具后消费

### 需求

现有 `src/query.ts` 工具后逻辑大致是：

```ts
if (
  pendingMemoryPrefetch &&
  pendingMemoryPrefetch.settledAt !== null &&
  pendingMemoryPrefetch.consumedOnIteration === -1
) {
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,
  )
  ...
}
```

改为复用 Step 4 的 `consumeRelevantMemoryPrefetch`，并增加 `!pendingMemoryPrefetch.skipped` 判断。

### 边界

- 工具后消费仍然是零等待：只有 `settledAt !== null` 才消费。
- 如果 `SYNC_RECALL` 已消费，工具后不再消费。
- 如果 `SKIP_RECALL` 已 abort，工具后不再消费。

### 验收标准

- 原有异步慢通路仍工作。
- 已同步消费 / 已跳过 / 未 settled 三种情况都不会阻塞工具后流程。

### 必测用例

1. `ASYNC_RECALL` + prefetch 已 settled：工具后注入 memory。
2. `ASYNC_RECALL` + prefetch 未 settled：工具后不等待，下轮 iteration 可重试。
3. `SYNC_RECALL` 已消费：工具后不重复注入。
4. `SKIP_RECALL` 已 skipped：工具后不注入。

## 7. Step 6：超时、失败、空结果处理

### 需求

给 Gate 和同步等待增加上限，避免首轮无限卡住。

建议实现：

```text
Gate timeout: 100~300ms，超时 → ASYNC_RECALL
SYNC memory wait timeout: 800~1500ms，超时 → 不注入 memory，继续首次 callModel
```

可新增 helper：

```ts
withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T>
```

### 边界

- Gate 超时不能 abort memory prefetch，因为默认降级为 `ASYNC_RECALL` 后还可能在工具后消费。
- `SKIP_RECALL` 才 abort memory prefetch。
- SYNC 等待超时后不要设置 consumed；如果 prefetch 后续 settled，是否允许工具后消费由实现选择：
  - 推荐：允许后续工具后消费，保持信息可用性。
  - 如果首次无 Tool Call，本 Turn 结束时 dispose 会 abort。

### 验收标准

- Gate 卡死不会阻塞主 loop。
- Memory prefetch 卡死不会阻塞首次 `callModel` 超过 timeout。
- 超时路径有 telemetry 或 debug log 可定位。

### 必测用例

1. Gate promise 永不 resolve：最终策略为 `ASYNC_RECALL`。
2. `SYNC_RECALL` memory promise 超时：首次 `callModel` 继续执行。
3. `SYNC_RECALL` memory promise reject：首次 `callModel` 继续执行，不抛出到主 loop。
4. `SKIP_RECALL` 不等待 timeout，立即 abort。

## 8. Step 7：Telemetry / Debug 事件

### 需求

复用现有 `logEvent` 风格，最少记录以下字段，方便测试和排查：

```text
recall_policy: SYNC_RECALL | ASYNC_RECALL | SKIP_RECALL
gate_latency_ms
gate_reason
sync_memory_wait_ms
sync_memory_injected_count
sync_memory_timeout
prefetch_skipped
prefetch_consumed_on_iteration
```

### 边界

- 不要记录 memory 文件正文。
- path 如果已有类似 telemetry 规范则沿用；否则最多记录 count，不记录敏感内容。

### 验收标准

- 三路策略都能看到对应 telemetry。
- 超时、skip、消费 iteration 能定位。

### 必测用例

1. `SYNC_RECALL` 记录注入数量。
2. `ASYNC_RECALL` 记录不阻塞首轮。
3. `SKIP_RECALL` 记录 skipped。
4. Gate timeout 记录 timeout。

## 9. Step 8：测试文件建议

根据仓库现有测试组织选择位置；如果没有现成 test 目录，建议新增靠近模块的单测：

```text
src/memdir/recallPolicy.test.ts
src/utils/attachments.memoryPrefetch.test.ts
src/query.memoryRecall.test.ts
```

测试优先级：

1. `recallPolicy` 纯函数 / 小模块测试。
2. `consumeRelevantMemoryPrefetch` 单测。
3. `query.ts` 主链路集成测试，mock `deps.callModel`、memory prefetch、Gate。

## 10. 最终必须通过的测试矩阵

| 编号 | 场景 | 期望 |
|---|---|---|
| T1 | 显式回忆请求，Gate=`SYNC_RECALL`，首轮无 Tool Call | 第一次 `callModel` messages 包含目标 `relevant_memories` |
| T2 | Gate=`SYNC_RECALL`，prefetch 返回 5 个 memory | 首轮最多注入 2 个 |
| T3 | Gate=`SYNC_RECALL`，memory path 已在 `readFileState` | 不注入重复 memory |
| T4 | Gate=`SYNC_RECALL` 已首轮注入，后续出现 Tool Call | 工具后消费点不重复注入 |
| T5 | Gate=`ASYNC_RECALL`，prefetch 未 settled | 第一次 `callModel` 不等待，不注入 |
| T6 | Gate=`ASYNC_RECALL`，工具后 prefetch settled | 工具后注入 memory |
| T7 | Gate=`SKIP_RECALL` | 调用 abort；首轮和工具后都不注入 |
| T8 | 用户明确说忽略历史 | Gate 返回 `SKIP_RECALL` |
| T9 | Gate 抛错 / 超时 / 非法输出 | 降级 `ASYNC_RECALL` |
| T10 | SYNC memory 等待超时 | 首次 `callModel` 继续执行，不抛异常 |
| T11 | SYNC memory promise reject | 首次 `callModel` 继续执行，不抛异常 |
| T12 | 用户 abort | Gate 与 prefetch 收到 abort signal，不发生后台注入 |
| T13 | prefetch skipped 后 promise resolve | 不消费、不注入 |
| T14 | prefetch dispose | 未完成任务被 abort，telemetry 不抛异常 |

## 11. 完成定义

代码完成必须同时满足：

1. `SYNC_RECALL / ASYNC_RECALL / SKIP_RECALL` 三路代码路径存在且可测试。
2. `SYNC_RECALL` 使用同一个 `pendingMemoryPrefetch.promise`，没有重复启动召回。
3. `SYNC_RECALL` 的 memory attachment 出现在第一次 `callModel` 前。
4. `ASYNC_RECALL` 保留现有零等待工具后消费能力。
5. `SKIP_RECALL` 能取消并阻止后续注入。
6. Gate 和 SYNC 等待都有超时兜底。
7. 去重、预算、Abort、空结果不破坏现有行为。
8. 第 10 节测试矩阵全部通过。

