# dsh-memory

`dsh-memory` 是 DeepSeek Harness（DSH）的受治理知识记忆插件。它以版本化 SQLite 数据为唯一事实来源，同时提供两种读取方式：模型获得经过作用域过滤且写入 session log 的小型检索结果，人可以浏览由数据库确定性生成的 Markdown 页面。

默认不把原始对话变成长久知识。显式启用 `autoConsolidate` 后，插件会在正常完成的轮次结束后异步提取少量新建或更新候选；候选默认仍需人类审核才能发布。可额外配置 `aiReviewMode: shadow` 记录 AI 审核建议但不改变候选，或 `aiReviewMode: enforce` 在本地作用域、敏感度、重复、冲突、来源和 revision 门禁全部通过且置信度达标时自动发布/拒绝；任何不确定情况都保留待人工审核。模型-facing 工具和提炼模型可以检索、读取、提议候选和反馈，但不能直接发布、扩大作用域、解决冲突或永久删除记录；reviewer 也只能通过上述本地策略门禁改变本次自动请求的新候选。

## 当前状态

当前版本为开发候选，不是已经完成生产验收的发布版。运行时、治理流程、备份恢复、Markdown 投影和评测入口已经实现，但真实模型 release 评测、常规 held-out 检索评测、人工页面审核、完整平台矩阵和 shadow/canary 等必需门禁仍未全部完成。当前证据以 [`docs/ACCEPTANCE_LEDGER.md`](docs/ACCEPTANCE_LEDGER.md) 为准；单元测试或开发期试验通过不能替代这些门禁。

## 功能与边界

- 保存带来源、作用域、敏感级别、状态、置信度和修订历史的结构化知识。
- 将模型提议先写入候选队列，由受信任的人类操作员审核后发布；可选 AI reviewer 仅在 `enforce` 且本地门禁全部通过时自动处理本次自动归纳候选。
- 在排序前过滤 workspace、session、agent、user、状态、敏感级别和过期时间。
- 在每轮首次模型请求前按配置自动检索，也提供 `memory_search`、`memory_read`、`memory_propose` 和 `memory_feedback` 工具。
- 可在正常完成的轮次后通过有界后台队列自动归纳；新建与更新先生成候选，AI 审核的 `shadow` 模式只记录建议，`enforce` 模式也只有通过本地治理门禁才会改变正式知识。
- 将实际送入模型的知识通过标准 session 输入记录，并将自动归纳与 AI review 的 source seq、路由、revision、策略、阈值和输入/输出摘要写入 append-only `memory_audit`，以便审计和重放。
- 生成只读 Markdown 投影，支持候选、冲突、生命周期、来源和修订浏览。
- 提供管理 CLI，用于审核、备份、恢复、导入导出、投影重建、保留策略和物理清理。

插件默认不扫描历史会话，也不会让模型审批自己的候选或把 Markdown 当作可编辑的事实来源。自动归纳仅处理启用后正常完成、同时包含直接用户文本与助手文本且带 workspace 的轮次。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`。
- Corepack 和 pnpm `10.33.0`。
- Cordis `^4.0.1`。
- 与 `package.json` 中 `peerDependencies` 匹配的 DSH `agent`、`llm`、`session` 和 `tools` 公开包；当前范围覆盖 `0.1.1-rc.2` 与 `0.1.2-alpha.1` 系列接口。

当前包没有正式发布标签。建议从固定 commit 构建 tarball，不要让部署依赖浮动的 Git checkout。

## 安装

npm 发布名为 `@muou000/dsh-memory`，可直接从 registry 安装：

```powershell
dsh plugin --profile web add '@muou000/dsh-memory@latest'
```

在源码仓库中安装依赖、检查并打包：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm pack
$tarball = (Resolve-Path .\muou000-dsh-memory-0.1.0.tgz).Path
```

把 tarball 安装到需要使用的 DSH profile：

```powershell
dsh plugin --profile web add $tarball
dsh --profile web --dump-config
```

包内 [`cordis.patch.yml`](cordis.patch.yml) 会插入 id 为 `dsh-memory` 的配置行。安装不会导入旧数据，也不会自动创建已发布知识；数据库在插件首次加载时按配置打开或创建。

## 配置

部署配置应在 profile 的 `cordis.patch.yml` 中按同一 `id` 覆盖。DSH patch 会替换整个 `config`，覆盖时需要重述所有要保留的字段：

```yaml
- id: dsh-memory
  config:
    dshHome: C:\managed\dsh
    autoInject: true
    autoConsolidate: true
    aiReviewMode: shadow
    reviewProvider: review-provider
    reviewModel: review-model
    maxInjectedItems: 6
    injectionTokenBudget: 1200
    consolidationMaxInputChars: 24000
    consolidationMaxOutputTokens: 1200
    consolidationTimeoutMs: 30000
    consolidationMaxProposals: 3
    consolidationRelevantMemoryLimit: 6
    consolidationMaxConcurrency: 1
    consolidationMaxPendingTurns: 32
    consolidationMaxQueuedChars: 1000000
    reviewMaxInputChars: 64000
    reviewMaxOutputTokens: 512
    reviewTimeoutMs: 30000
    reviewMinConfidence: 0.9
    markdownProjection: true
    secretPolicy: reject
    logQueryText: false
```

常用配置：

| 配置 | 默认值 | 作用 |
| --- | ---: | --- |
| `storagePath` | `<DSH_HOME>/memory/v1/memory.sqlite` | 规范 SQLite 文件；显式设置时必须是绝对路径 |
| `projectionPath` | 数据库同级的 `knowledge/` | Markdown 投影目录；显式设置时必须是绝对路径 |
| `readOnly` | `false` | 只读打开现有数据库，禁止提议和反馈等写入 |
| `autoInject` | `true` | 在一轮首次模型请求前检索可见知识 |
| `autoConsolidate` | `false` | 正常轮次结束后异步生成候选；因模型成本和数据发送边界而默认关闭 |
| `aiReviewMode` | `off` | `off` 不调用 reviewer；`shadow` 只记录 AI 建议；`enforce` 仅在本地门禁通过时自动发布/拒绝；后两者要求 `autoConsolidate: true` |
| `reviewProvider` / `reviewModel` | 未设置 | AI reviewer 路由，必须成对设置，并且启用 reviewer 时必须与归纳路由不同 |
| `consolidationProvider` / `consolidationModel` | 未设置 | 固定辅助模型路由，必须成对设置；未设置时沿用该轮助手响应的路由 |
| `consolidationMaxInputChars` / `consolidationMaxOutputTokens` | `24000` / `1200` | 单次自动归纳输入字符上限和输出 token 上限 |
| `consolidationTimeoutMs` | `30000` | 单次辅助模型请求超时，单位毫秒 |
| `consolidationMaxProposals` / `consolidationRelevantMemoryLimit` | `3` / `6` | 每轮最多候选数和可供更新的同 workspace 已发布记忆数 |
| `consolidationMaxConcurrency` / `consolidationMaxPendingTurns` | `1` / `32` | 后台并发数和等待队列上限 |
| `consolidationMaxQueuedChars` | `1000000` | pending 与 active 归纳任务的总输入字符预算 |
| `reviewMaxInputChars` / `reviewMaxOutputTokens` | `64000` / `512` | 单次 AI review 的完整候选帧输入上限和输出 token 上限 |
| `reviewTimeoutMs` / `reviewMinConfidence` | `30000` / `0.9` | review 请求超时和自动决策最低置信度 |
| `maxInjectedItems` | `6` | 一次自动注入最多返回的记录数 |
| `injectionTokenBudget` | `1200` | 自动注入的估算 token 上限 |
| `drillDownTokenBudget` | `4096` | `memory_read` 返回详情的估算 token 上限 |
| `retrievalCandidateLimit` | `24` | 排序前最多考虑的候选数，不能小于 `maxInjectedItems` |
| `minConfidence` | `0.6` | 普通检索接受的最低置信度 |
| `secretPolicy` | `reject` | 对疑似密钥候选执行 `reject` 或 `redact` |
| `logQueryText` | `false` | 是否持久化原始检索文本；默认只记录查询哈希 |
| `markdownProjection` | `true` | 是否生成供人浏览的 Markdown 投影 |
| `busyTimeoutMs` | `5000` | SQLite 锁等待时间，单位为毫秒 |
| `integrityCheckOnStart` | `true` | 启动时执行 SQLite `quick_check` |

自动归纳只发送当前轮的直接用户文本与助手可见文本，不发送 reasoning、工具结果或插件注入消息。若设置专用模型，`consolidationProvider` 和 `consolidationModel` 必须同时设置；否则使用产生该轮助手消息的相同路由。所有未知配置键和越界值都会在插件加载时被拒绝。完整字段、保留时间和维护阈值见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)、[`docs/AUTOMATIC_MEMORY.md`](docs/AUTOMATIC_MEMORY.md) 与 [`src/config.ts`](src/config.ts)。

## 使用与验证

加载 profile 后先检查最终组合，再检查数据库和 Markdown 投影：

```powershell
dsh --profile web --dump-config
dsh --profile web
dsh-memory status --dsh-home C:\managed\dsh
dsh-memory projection-status --dsh-home C:\managed\dsh
```

`knowledge/README.md` 是人类浏览入口。该目录是数据库的可重建投影，不应手工修改。候选审核和生命周期变更通过 `ctx.memories` 的受信同进程调用方或管理 CLI 完成，例如：

```powershell
dsh-memory candidates --store C:\managed\memory.sqlite
dsh-memory publish <candidate-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Evidence checked by owning team."
dsh-memory maintenance --store C:\managed\memory.sqlite
```

模型工具和自动归纳器只能读取或提议。AI reviewer 只接收完整候选、同 workspace 的当前记录摘要和裁剪后的来源文本，明确设置 `tools: []`；本地会再次检查 scope、sensitivity、secret、duplicate、conflict、source hash 和 revision。`shadow` 只写审计，`enforce` 才能在全部门禁满足时自动处理本次归纳请求新建的候选；低置信、矛盾、异常、过期或状态变化全部 defer。`dsh-memory candidates` 同时列出工具提议与自动归纳候选；人工审核者应先按候选中的 `session-event` locator 回看来源轮次，再执行 `publish`、`reject` 或 `skip`。发布、拒绝、冲突处理、生命周期转换、保留清理和物理 purge 要求明确的 actor 与审计原因。

## 数据、备份与删除

默认数据布局：

```text
<DSH_HOME>/memory/v1/
├─ memory.sqlite        # 规范数据；运行时可能有 WAL/SHM 文件
├─ memory.sqlite.writer.lock  # writer lock sidecar
└─ knowledge/           # 可删除并重建的 Markdown 投影
```

使用管理 CLI 创建经过 SQLite 校验的备份或可移植 JSON 导出：

```powershell
dsh-memory backup C:\backup\memory.sqlite --store C:\managed\memory.sqlite
dsh-memory export --store C:\managed\memory.sqlite > C:\backup\memory.json
dsh-memory restore C:\backup\memory.sqlite C:\managed\memory-restored.sqlite
dsh-memory rebuild --store C:\managed\memory-restored.sqlite
```

恢复和导入应写入新的或空的目标，验证 `status`、`rebuild` 和 `projection-status` 后再切换部署路径。逻辑删除必须先发生，物理删除还要求精确确认 memory id：

```powershell
dsh-memory purge <memory-id> --confirm <memory-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Approved privacy purge."
```

物理 purge 不可恢复。数据库、投影和审计数据可能包含项目私有信息，应使用受限文件权限、受管存储和明确的保留策略。

## 停用与回滚

先停止使用该 profile 的 DSH 进程并保存数据库备份，然后移除插件：

```powershell
dsh plugin --profile web remove '@muou000/dsh-memory'
dsh --profile web --dump-config
```

移除插件不会删除数据库或 Markdown 投影。回滚版本时保留旧数据库与导出，安装先前固定的 tarball，在隔离路径执行 `status` 和 `rebuild` 后再切换。不要通过手工编辑 Markdown 或改写旧审计记录完成回滚。

## 开发与验收

普通检查、Loader 组合和独立评测需要分别运行：

```powershell
corepack pnpm run check
corepack pnpm run test:integration
corepack pnpm run eval:keyless
corepack pnpm run eval:benchmark
corepack pnpm run eval:operations
corepack pnpm run eval:pack
```

`pnpm run check` 只代表类型检查、普通测试和构建通过。真实模型 release 数据集、Unix、完整 Node/平台矩阵和部署 canary 都是独立验收项；要求和当前状态分别见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) 与 [`docs/ACCEPTANCE_LEDGER.md`](docs/ACCEPTANCE_LEDGER.md)。

## 已知限制

- 当前生产验收未完成，不能把开发期评测外推为通用质量、成本或延迟收益。
- 自动归纳仅完成 mock 模型和真实 Loader 的确定性测试；尚未完成真实模型抽取质量、误报率、成本、延迟及多轮更正传播评测。
- 自动归纳队列是进程内有界队列，没有跨进程 durable outbox 或失败重试；调用前先 flush 标准 session 事件，并在 append-only `memory_audit` 中记录 prompt 版本、源 seq、路由、target revision 与输入 hash，成功后记录 candidate ids。进程在该审计写入前崩溃时不会自动补跑。
- 审计记录可重建插件提交给 LLM runtime 的输入，但不声称捕获 runtime middleware 或 provider adapter 的内部变换。`session/flush` 没有上游取消参数；插件取消时会停止等待，持久化 provider 仍须自行管理其未完成操作。
- 自动检索依赖结构化作用域、置信度和词法候选；记录缺少准确适用范围或来源时，人工审核仍是必要步骤。
- Markdown 首次生成、恢复、导入和显式修复需要完整重建；大型知识库应预留维护窗口。
- 存储加密、密钥轮换、文件权限和跨主机复制由部署环境负责。
- 投影失败不会回滚已提交的规范数据库写入；需要修复原因后运行 `rebuild`。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：数据模型、服务和信任边界。
- [`docs/AUTOMATIC_MEMORY.md`](docs/AUTOMATIC_MEMORY.md)：Claude Code/Codex 调查快照、自动触发设计与审核边界。
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)：审核、备份、恢复、保留和上线步骤。
- [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)：生产验收门禁。
- [`docs/ACCEPTANCE_LEDGER.md`](docs/ACCEPTANCE_LEDGER.md)：当前 checkout 的证据状态。
- [`evals/README.md`](evals/README.md)：评测入口和报告解释。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
