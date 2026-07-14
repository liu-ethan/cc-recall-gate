# CC Recall Gate

<p align="center">
  <img alt="Claude Code Restored" src="https://img.shields.io/badge/Claude%20Code-Restored%20Source-111111?style=for-the-badge&logo=anthropic&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Agent%20Runtime-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-%E2%89%A51.3.5-000000?style=for-the-badge&logo=bun&logoColor=white">
  <img alt="Memory Recall Gate" src="https://img.shields.io/badge/Memory-Recall%20Gate-4B5563?style=for-the-badge">
</p>

> 基于 Claude Code 还原源码的 Agent Runtime 改造项目，聚焦“记忆召回结果必须在模型决策前可用”这一核心问题。项目用途为技术交流、架构分析与 Runtime 原型验证。

本仓库不是重新实现一个 Agent，也不是给 Claude Code 外挂一个独立记忆库；它在 Claude Code 既有 Agent Loop、Tool Calling、Auto Memory 与上下文组装机制之上，补齐“详细记忆异步召回可能晚于首轮模型调用”的控制流缺口。

## 项目定位

Claude Code 原有记忆链路中，Auto Memory 的详细文件召回会在每个 User Turn 启动异步预取，但通常要到工具执行之后才被消费并注入上下文。

这对普通编码请求很合理，因为它不阻塞首 Token；但对“你还记得我之前说过什么”“按上次方案继续”这类强依赖历史的请求，如果首轮模型直接回答且没有 Tool Call，召回结果就可能在本 Turn 中完全没有进入主模型上下文。

本项目的改造目标是：

```text
用户输入
  ↓
同时启动 Memory Recall Gate 与记忆预取
  ↓
根据当前请求对历史记忆的依赖程度选择策略
  ↓
在正确性、首 Token 延迟、Token 成本和上下文噪声之间做可验证权衡
```

## 基于 Claude Code 的改进

| 改进点 | Claude Code 原链路 | 本项目改造 |
|---|---|---|
| 首轮记忆可用性 | 详细记忆预取通常在 Tool Loop 后消费；无 Tool Call 时本轮可能用不上 | 明确需要历史信息时，在本 Turn 第一次 `callModel` 前注入 Top 1～2 条记忆 |
| 召回策略 | 以异步预取为主，优先不阻塞主模型 | 引入 `SYNC_RECALL / ASYNC_RECALL / SKIP_RECALL` 三路门控 |
| 延迟控制 | 不等待召回，普通请求体验好，但强记忆请求可能失真 | Gate 与预取并发启动，只让强记忆请求支付同步等待成本 |
| 资源控制 | 详细记忆最多由现有 selector 选择，后续消费时去重 | 首轮只注入高置信 Top 1～2，继续复用单文件 4KB、单会话 60KB 等预算 |
| 失败降级 | 异步任务失败时不影响主流程 | Gate 超时/异常降级为 `ASYNC_RECALL`；同步召回失败时禁止模型伪造历史 |
| 用户控制 | 用户可通过语义表达影响回答，但召回链路缺少显式跳过策略 | 用户明确要求忽略历史时走 `SKIP_RECALL`，取消本轮预取并阻止后续注入 |
| 可观测性 | 召回延迟与是否真正参与首轮决策容易混在一起 | 单独度量 Gate 延迟、召回延迟、首轮记忆可用率、TTFT 变化和错误注入率 |

## 核心架构

```text
User Turn
  │
  ├─ Memory Recall Gate
  │    ├─ SYNC_RECALL  明确依赖历史：等待同一个预取 Promise
  │    ├─ ASYNC_RECALL 不确定：保持异步，不阻塞首轮
  │    └─ SKIP_RECALL  明确无关或用户禁止：取消预取
  │
  ├─ Relevant Memory Prefetch
  │    ├─ 复用 Claude Code 现有 memory scan / selector
  │    ├─ 共享 Promise、AbortController 与消费状态
  │    └─ 遵守 readFileState、surfaced paths 与 Token 预算
  │
  └─ Agent Loop
       ├─ 组装 messagesForQuery
       ├─ 首次 callModel 前按策略注入或跳过记忆
       ├─ 解析 Tool Call
       ├─ 权限校验与工具执行
       └─ 工具结果与后续异步记忆回灌
```

### 三路策略

`SYNC_RECALL`：当前请求明确依赖历史信息，例如“还记得”“上次说过”“按我之前的偏好”。系统等待已经启动的记忆预取，在首次主模型调用前注入少量高置信记忆。

`ASYNC_RECALL`：是否需要历史信息不确定。系统不阻塞首次模型调用，保留现有异步预取与后续 Tool Loop 回灌能力。Gate 失败、超时或返回非法结果时默认进入该分支。

`SKIP_RECALL`：请求明确不需要历史，或用户显式要求忽略记忆。系统取消本 Turn 的记忆预取，并确保后续 Loop 不再消费该结果。

## 设计原则

第一性原理是：记忆系统的价值不等于“存得多”，而是“正确的信息在模型做决定时可用”。

因此本项目坚持四个原则：

1. **不重建记忆库**：复用 Claude Code 既有 Auto Memory、memory scan、selector、attachment 与预算体系。
2. **不全量同步阻塞**：只有强历史依赖请求才等待召回，普通请求仍保持低 TTFT。
3. **不让记忆污染上下文**：首轮只注入 Top 1～2；低置信和不确定请求继续走异步慢通路。
4. **不伪造历史事实**：召回超时、失败或为空时，模型应知道“未找到可用记忆”，而不是编造过去内容。

## 验证体系

本项目不以单个 Demo 成功作为验收标准，而是用控制流测试和离线回放验证端到端收益。

### 控制流测试

| 场景 | 验证点 |
|---|---|
| Gate=`SYNC_RECALL` 且首轮无 Tool Call | 第一次 `callModel` 的 messages 已包含目标记忆 |
| Gate=`ASYNC_RECALL` | 首次模型调用不等待记忆，后续 Loop 可消费预取结果 |
| Gate=`SKIP_RECALL` | 预取被取消，首轮和后续轮均不注入记忆 |
| Gate 超时或异常 | 自动降级为 `ASYNC_RECALL`，主 Loop 不被卡死 |
| 同步召回为空或失败 | 主模型收到受控提示，不声称自己记得 |
| 同一文件被同步和异步同时选中 | 通过 `readFileState` 与 surfaced paths 去重 |
| 用户中断 | Gate、预取和文件读取均收到 Abort |

### 对照实验

```text
A：Claude Code 原有纯异步召回
B：所有请求都同步等待召回
C：本项目 Gate + 并发预取 + 三路策略
```

C 组的目标不是在所有指标上压倒 A/B，而是在强记忆场景接近 B 的正确性，同时让普通请求的首 Token 延迟接近 A。

### 核心指标

| 指标 | 说明 |
|---|---|
| First-call Memory Availability | 首次主模型调用前是否已包含目标记忆 |
| Task Accuracy | 最终回答是否正确使用历史信息 |
| Gate Accuracy | 三路策略是否把请求路由到正确分支 |
| False Injection Rate | 无关请求被错误注入记忆的比例 |
| Stale-memory Error Rate | 陈旧记忆导致错误行动的比例 |
| p50/p95 TTFT Delta | 普通请求与强记忆请求的首 Token 延迟变化 |
| Injected Tokens | 每轮额外注入的 Token 成本 |
| Cancel / Timeout Success Rate | 中断、超时和失败降级是否生效 |

## 代码锚点

| 文件 | 作用 |
|---|---|
| `src/query.ts` | User Turn 主循环、记忆预取启动、上下文组装、首次 `callModel`、工具后回灌 |
| `src/utils/attachments.ts` | `MemoryPrefetch`、记忆 attachment、去重、预算与 Abort 入口 |
| `src/memdir/findRelevantMemories.ts` | 复用现有 Sonnet selector，选择相关记忆文件 |
| `src/memdir/memoryScan.ts` | 扫描 memory manifest，限制候选规模 |
| `src/context.ts` | 会话级用户上下文与 CLAUDE.md / MEMORY.md 栈加载 |
| `src/services/SessionMemory/` | Session Memory 的增量摘要写入链路 |
| `src/services/compact/` | Compact 时读取 Session Memory 并替换历史消息 |

## 运行方式

环境要求：

- Bun `>= 1.3.5`
- Node.js `>= 24`

安装依赖：

```bash
bun install
```

启动本地 CLI：

```bash
bun run dev
```

查看版本：

```bash
bun run version
```

## 仓库结构

```text
src/
  query.ts                         # Agent Loop 主链路
  utils/attachments.ts             # attachment、memory prefetch、预算与去重
  memdir/                          # Auto Memory 扫描与相关性选择
  services/SessionMemory/          # 会话内滚动摘要
  services/compact/                # Compact / Resume 上下文治理
  tools/                           # 核心工具实现
  permissions/                     # 权限控制
  context.ts                       # 用户上下文与项目上下文加载
```
