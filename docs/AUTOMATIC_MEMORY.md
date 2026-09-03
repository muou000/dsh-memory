# 自动记忆调查与设计

调查日期：2026-09-02。

本文是外部机制的证据快照和 `dsh-memory` 自动归纳设计说明，不是对 Claude Code 或 Codex 未来版本的保证。Claude Code 结论以 Anthropic 官方文档为准；Codex 发布行为以 OpenAI 官方文档为准，源码细节固定到 `openai/codex` commit `a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67`。

## Claude Code

Claude Code 区分人工维护的 `CLAUDE.md` instructions 与模型维护的 auto memory：

- 项目 instructions 位于 `./CLAUDE.md` 或 `./.claude/CLAUDE.md`，用户 instructions 位于 `~/.claude/CLAUDE.md`。启动时按目录层级加载，子目录 instructions 在访问相应目录时延迟加载。
- Auto memory 默认位于 `~/.claude/projects/<project>/memory/`，以 `MEMORY.md` 为有界索引，topic files 按需读取。官方说明其默认启用，模型在会话过程中判断哪些信息值得保存，并非每个会话都保存。
- 官方没有公开 auto memory 的抽取模型、prompt、阈值、精确触发顺序、原子写入、并发处理或失败重试实现，也没有公开 `MemorySaved`/`MemoryUpdated` hook。
- `Stop` 表示主 agent 完成一次响应，不等于会话退出。`SessionEnd` 才覆盖正常退出，但预算短且不能阻止退出；异常进程结束没有必达保证，因此不适合成为唯一落盘点。
- Async command hooks 每次触发独立运行、不去重、不能作审批决策，进程退出时也不保证继续执行。
- `/memory` 支持写后浏览和编辑普通 Markdown，但没有内建逐条写入前审批、revision lineage、来源 session/turn 或持久审核账本。

来源：

- [Manage Claude's memory](https://code.claude.com/docs/en/memory)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Context windows and compaction](https://code.claude.com/docs/en/context-window)
- [Claude Code settings](https://code.claude.com/docs/en/settings-reference)
- [Claude Code data storage](https://code.claude.com/docs/en/claude-directory)

## Codex

Codex 区分确定性 instructions、线程日志、用户输入 history、单会话 compaction 和实验性 local memories：

- `AGENTS.md` 是确定性指令层。Codex 启动时从全局和 project root 到 cwd 分层读取，项目内容有总字节预算；不可信项目不加载项目 instructions。
- Rollout JSONL 是可 resume/fork 的线程日志，由单 writer 队列串行追加并支持 flush。`history.jsonl` 只保存用户输入历史；关闭 history 不等于关闭 rollout。
- Compaction 在当前 turn 中同步生成有损摘要并追加 checkpoint，旧 rollout 行仍保留。它不是跨会话 memory consolidation。
- Local Memories 由 `[features] memories=true` 开启，官方标记为 experimental 且默认关闭。它在合格 root session 启动时后台扫描已经闲置的旧线程，而不是在上一轮结束时立即执行。
- 固定源码中的写路径分两阶段：Phase 1 用数据库 lease 领取有界候选并并行抽取、清理 secret；Phase 2 持全局 lease，基于 usage/时间选择输入，再由受限临时 agent 串行归并 memory artifacts。
- 读取侧只注入短 summary，再按需读取详情，并记录 usage 信息。用户主动更新先写新的 ad-hoc note，后续 consolidation 再吸收。
- 当前没有逐条人工 promote 门。内部 Git 主要用于产物 diff/baseline，不等于不可改写审核账本。
- Hooks 与 built-in memories 是独立机制。Async hook 有并发上限、在下一 safe point 交付结果，并在 session 结束时取消；`SessionEnd` 保持同步。

官方来源：

- [AGENTS.md discovery](https://developers.openai.com/codex/agent-configuration/agents-md/)
- [Codex configuration](https://developers.openai.com/codex/config-file/config-reference/)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Codex memories](https://developers.openai.com/codex/customization/memories/)
- [Codex hooks](https://developers.openai.com/codex/hooks/)

固定源码证据：

- [Memory architecture](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/memories/README.md)
- [Memory startup worker](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/memories/write/src/start.rs)
- [Phase 2 consolidation](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/memories/write/src/phase2.rs#L308-L355)
- [Rollout recorder](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/rollout/src/recorder.rs)
- [Local compaction](https://github.com/openai/codex/blob/a0dcfe2ada3f5bbd5059a34c0fc6fac244741a67/codex-rs/core/src/compact.rs)

Codex 文档和同日 main 源码对 `max_rollouts_per_startup`、`max_rollout_age_days` 等默认值存在偏差。这些目录、SQLite 名称、JSONL wire schema 和阈值都不是稳定插件 API，不能复制为 `dsh-memory` 的硬编码契约。

## 采用的机制

`dsh-memory` 选择每个正常完成的 DSH `turn/end` 作为触发点：

1. Session listener 同步读取已经提交的当前轮，只保留直接用户文本和 assistant text，排除 reasoning、工具结果和插件注入消息。
2. Listener 把不可变快照放入有界进程内队列并立即返回，不让辅助模型延迟当前 agent loop。
3. Worker 用本轮文本进行同 workspace 检索，只把有界已发布记录作为合法 update target。
4. Worker 先 flush 源 Session 的标准事件，不向 DSH log 注入仓库外 event type；随后通过 `prepareCall` 固定模型注册和默认控制项，并在 append-only `memory_audit` 写入 prompt version、模型路由、源消息 seq、候选 target revision、token 上限与 system/input SHA-256。
5. 辅助模型无工具，只能返回 strict JSON 的 `create` 或 `update` 提案。Scope、sensitivity、owner、evidence、expected revision 和幂等 request id 由插件控制。
6. 所有提案先通过现有 secret/private-context、长度和结构校验，再写入 SQLite candidate queue。模型不能扩大作用域、产生 contradiction 或改动当前 revision。
7. 成功后在 `memory_audit` 写入只含 candidate ids 的 completion row。`aiReviewMode=off` 到此结束；`shadow` 或 `enforce` 会先用本地敏感信息扫描过滤来源，再把完整候选、裁剪后的来源和同 workspace target/duplicate 摘要交给显式独立路由的 no-tools reviewer。
8. Reviewer 只返回 strict JSON verdict、置信度和 grounding/durability/scope/sensitivity/usefulness/duplicate/conflict checks。SQLite 事务再次核对候选 requestId、actor、content hash、source hash、scope、revision、重复和冲突；`shadow` 一律 defer，`enforce` 只在 verdict、阈值、模型 checks 和本地门禁一致时 publish/reject，其他结果仍由人审核。
9. AI review request/result 写入 append-only `memory_audit`；result audit 与 candidate transition 在同一事务中提交，不记录原始来源或 reviewer reason，只保留 hashes、路由、策略版本、阈值、checks 与 effective action。
10. Session 释放会取消该 Session 的排队/活跃 work；插件卸载先移除 listener，再中止并等待提炼和 review，最后才关闭 SQLite。上游 `session/flush` 没有取消参数，插件会停止等待，但不能替持久化 provider 取消其内部操作。

这种设计采用了 Claude 的“有界索引和按需详情”思想、Codex 的“后台有界任务和分离抽取/归并”思想，但增加了两者公开机制都没有保证的候选审批、optimistic revision、来源引用/输入 hash 和不可变审核记录。

## 启用与审核

自动归纳默认关闭，因为它会增加模型调用成本，并可能把当前轮文本发送给显式配置的另一模型提供商。启用后无需模型调用 `memory_propose`：

```yaml
- id: dsh-memory
  config:
    autoConsolidate: true
    consolidationMaxInputChars: 24000
    consolidationMaxOutputTokens: 1200
    consolidationTimeoutMs: 30000
    consolidationMaxProposals: 3
    consolidationRelevantMemoryLimit: 6
    consolidationMaxConcurrency: 1
    consolidationMaxPendingTurns: 32
    consolidationMaxQueuedChars: 1000000
    aiReviewMode: shadow
    reviewProvider: review-provider
    reviewModel: review-model
    reviewMaxInputChars: 64000
    reviewMaxOutputTokens: 512
    reviewTimeoutMs: 30000
    reviewMinConfidence: 0.9
```

未设置 `consolidationProvider`/`consolidationModel` 时沿用该轮 assistant message 的 route。设置专用 route 时两项必须同时出现。AI reviewer 使用 `reviewProvider`/`reviewModel`，两项必须同时出现且实际解析 route 不能与提炼 route 相同。先用 `shadow` 做配对评测，再谨慎切换 `enforce`；切回 `shadow` 或 `off` 是停止条件，但不会撤销已经产生的 revision。审计中的 SHA-256 是完整性摘要，不是匿名化；审计数据库仍按敏感数据保护。

```powershell
dsh-memory candidates --store C:\managed\memory.sqlite
dsh-memory publish <candidate-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Source turn and applicability verified."
dsh-memory reject <candidate-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Not durable project knowledge."
```

审核时必须检查：来源 Session/turn 是否支持结论、适用条件是否过宽、目标 revision 是否仍为当前版本、是否包含临时状态或个人信息、是否与近似候选冲突。

## 当前限制

- 只处理 `reason.kind === completed`、带绝对 workspace、同时含直接用户文本与 assistant text 的轮次。
- 进程内队列不是 durable outbox。consolidation request audit 写入前发生进程崩溃时不会自动补跑；失败请求也没有插件级 lease/backoff 重试。
- 审计 hash 可校验由标准 Session 事件重建出的插件级请求，但不覆盖 LLM runtime middleware 或 provider adapter 的内部变换。
- 自动归纳不会合并尚未审核的候选；精确重复由现有 content hash 跳过，近似重复只作为审核提示。
- 当前只通过 mock 模型、真实 Cordis Loader、Agent Loop、取消和配置边界测试。真实模型误报率、漏报率、更正传播、成本和延迟尚未评测。
- 在完成配对真实模型评测、人工审核和 shadow/canary 前，不能把 `autoConsolidate` 作为生产默认值，也不能把 `aiReviewMode: enforce` 作为生产默认值。推荐先以 `shadow` 记录 publish precision、false-reject、跨作用域泄漏、成本/延迟和对抗性 prompt injection 结果。
