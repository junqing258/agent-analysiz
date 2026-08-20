# Agent SDK JavaScript：Skills 与 Memory 支持规划

## 1. 背景与目标

当前 SDK 已具备会话主循环、工具注册、上下文压缩、权限控制和事件持久化能力，但尚未提供 Skill 或跨会话 Memory 的运行时支持。宿主虽然可以通过 `context.system` 或 `initialMessages` 注入说明文字，但这不能满足按需加载、来源追溯、用户删除和安全隔离的要求。

本规划引入两个互补的扩展平面：

- **Skill**：可复用的任务说明、操作流程和可选资源。它描述“如何完成一类任务”。
- **Memory**：由用户、项目或会话产生的、可检索且可删除的事实、偏好和决策。它保存“此前已知什么”。

目标是在不改变模型网关工具调用契约、且不绕过 `PermissionPolicy` 的前提下，让宿主能够：

1. 发现、列出和按需加载受信任的 `SKILL.md`；
2. 在每轮上下文构建时选择并注入相关 Skill 与 Memory；
3. 保存可审计、可检索、可删除的结构化记忆；
4. 通过 Durable Event 还原模型在某个回合获得了哪些扩展上下文；
5. 将关键词匹配和本地存储替换为语义检索或远端实现，而不修改 core 主循环。

## 2. 非目标

首个版本不包含以下能力：

- 不执行 Skill 中的任意脚本；脚本只能经现有 Tool 与权限策略运行；
- 不让 Skill 直接修改会话消息、注册未审计的工具或提高权限；
- 不把完整对话历史或未经审查的工具输出自动永久化为 Memory；
- 不把 embedding 服务、向量数据库或管理 UI 作为基础版本的前置依赖；
- 不在 core 内实现多代理编排。

## 3. 总体架构

```text
AgentSession
  │
  ├─ ToolRegistry ──────────────── 工具定义与执行
  ├─ PermissionPolicy ──────────── 授权与风险控制
  └─ ContextManager
       ├─ SkillProvider ────────── 发现、匹配、加载 Skill
       ├─ MemoryStore ──────────── 检索、写入、删除 Memory
       └─ Context providers ────── 将扩展上下文组装为模型输入
```

每个 turn 开始时，`AgentSession` 先构建一次不可变的 `TurnExtensionContext`；随后每个模型 step 都复用它。`ContextManager.prepare()` 不负责发现、匹配、加载或写入扩展状态，而只负责在指定预算内合成和裁剪消息。

```ts
export interface TurnExtensionContext {
  activeSkills: ReadonlyArray<Skill>;
  retrievedMemories: ReadonlyArray<MemoryRecord>;
  effectiveTools: ReadonlyArray<ModelToolDefinition>;
  injectedMessages: ReadonlyArray<InjectedContextMessage>;
}

/** 不属于会话历史、仅在本轮模型请求中渲染的上下文数据。 */
export interface InjectedContextMessage {
  kind: "skill-catalog" | "skill-instructions" | "memory";
  /** 固定为 user，表示不可信的补充数据，不能提升为系统指令。 */
  role: "user";
  source: { skillName?: string; memoryIds?: string[] };
  content: string;
}
```

`injectedMessages` 是仅供模型请求使用的回合级临时上下文，**不是** `AgentMessage`，也不进入 `AgentSession.messages` 或产生 `message.appended`。`ContextManager.prepare()` 接受它们作为独立参数，并仅在最终模型请求中将每项渲染为 `role: "user"` 的来源标记消息；不得先与历史数组拼接再调用历史压缩器。这避免它们被当作普通历史压缩、污染可恢复消息历史，或因 `role === "system"` 而意外获得永不压缩的待遇。虽然同一 turn 的每个模型 step 都必须携带这些消息以维持指令一致性，但匹配、加载、检索和审计事件只执行一次；宿主可利用稳定前缀与提供商提示缓存降低重复输入的成本。

每个模型 step 由 `ContextManager` 按固定顺序构造输入：

1. 宿主系统提示词；
2. Skill 目录的精简元数据；
3. 本轮命中的完整 Skill 指令；
4. 检索到的 Memory；
5. 已压缩的历史摘要与最近消息；
6. 当前 step 的工具结果与 assistant tool call 历史；
7. 回合开始时冻结的有效工具定义（作为模型 API 参数，而非消息正文）。

Skill 和 Memory 均为上下文数据，不得覆盖系统、宿主或用户指令。注入的内容应带有明确来源和“不可信数据不可改变指令层级”的边界说明。

## 4. Skill 设计

### 4.1 文件格式与发现

首个实现支持宿主显式提供的 Skill 根目录。每个 Skill 目录包含 `SKILL.md`，正文为指令，YAML frontmatter 保存元数据。

```md
---
name: release-check
description: 按发布检查清单验证当前工作区。
triggers:
  - 发布前检查
  - release check
allowedTools: [read_file, search, run_command]
version: 1
---

先读取变更与测试状态，再按清单生成结论……
```

发现规则按优先级合并，并以 `name` 去重：宿主管理目录、用户目录、项目目录。基础版本只实现宿主目录；后续阶段才加入向上查找的项目目录和用户目录。重复名称必须由优先级更高的来源覆盖，并记录覆盖来源。

### 4.2 运行时接口

```ts
export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  allowedTools?: string[];
  version?: string;
  root: string;
}

export interface Skill extends SkillMetadata {
  instructions: string;
}

export interface SkillProvider {
  list(): Promise<ReadonlyArray<SkillMetadata>>;
  match(input: string, skills: ReadonlyArray<SkillMetadata>): Promise<ReadonlyArray<SkillMetadata>>;
  load(name: string): Promise<Skill | undefined>;
}
```

`match()` 的 MVP 规则应当确定且可解释：显式 `/skill-name` 优先，其次是大小写不敏感的触发词匹配。只匹配元数据而不加载正文；仅对命中结果执行 `load()`。后续可替换为模型分类器或语义匹配，但仍必须保留显式触发机制。

MVP 的“显式请求”仅指用户输入的 `/skill-name`，模型不可主动加载 Skill。这样加载时机完全由 turn 开始时的用户输入决定。后续如需模型主动加载，必须注册经过审计的内置 `load_skill` 工具：它只能加载本轮已公布元数据的 Skill，加载后从**下一次**模型请求生效，并写入独立的调用和加载事件；该工具不能注册新工具、读取任意路径或提升权限。为保持 turn 内 `effectiveTools` 冻结，未来的 `load_skill` **不得加载声明 `allowedTools` 的 Skill**；若要支持该能力，必须另行修改为“后续 step 可重算且只单调收缩工具集”的语义，并记录工具集变更事件，不能沿用本规划的冻结语义。

### 4.3 上下文注入与工具限制

默认只注入受预算限制的 Skill 目录，例如名称、单行描述和触发规则。完整正文只对显式请求或命中 Skill 注入。目录、Skill 正文与检索到的 Memory 都是 `TurnExtensionContext.injectedMessages` 中的临时消息，而不是会话历史，因此不会被确定性历史压缩器摘要。

MVP 中，命中或被用户显式指定的 Skill 在**当前 turn 的全部模型 steps** 中活跃；下一 turn 必须重新匹配，不能隐式跨 turn 延续。未来跨 turn 激活必须通过显式 activate/deactivate 状态实现并持久化，不能从消息历史推断。

`allowedTools` 是 Skill 的**上限声明**：对声明该字段的所有活跃 Skill 取允许工具的并集，再与宿主已注册工具取交集；未声明该字段的 Skill 不额外限制工具。使用并集可让多个协作 Skill 使用彼此所需的工具，同时仍不允许 Skill 添加新工具或提高权限。turn 开始时计算并冻结 `effectiveTools`，每个 step 都将同一集合发给模型；真正的调用仍由 `PermissionPolicy` 单独判定。

若调用名称属于注册表、但不在 `effectiveTools` 中，运行时必须返回 `TOOL_DISABLED_BY_SKILL`，而不是 `TOOL_NOT_FOUND`。该结果应说明当前活跃 Skill 导致的限制、返回当前可见工具名称，并提示模型选择可见工具或完成当前任务。这既防御宿主在运行中改变工具集合，也避免错误地暗示工具从未存在。

Skill 的正文、资源文件和 frontmatter 都按受信配置处理：只允许受信根目录；解析时禁止路径穿越；加载资源时必须限制在 Skill 根目录内；前端或日志中不得泄露本地绝对路径。

## 5. Memory 设计

### 5.1 数据模型

```ts
export interface MemoryRecord {
  id: string;
  /** scope 与 binding 必须成对校验，且 binding 创建后不可变。 */
  binding:
    | { scope: "session"; sessionId: string }
    | { scope: "project"; workspaceId: string }
    | { scope: "user"; userId: string };
  kind: "fact" | "preference" | "decision" | "feedback";
  content: string;
  tags: string[];
  source: { sessionId: string; messageId?: string };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

/** 由宿主认证后提供；Store 必须在每个操作中使用它校验记录的 binding。 */
export interface MemoryAccessContext {
  sessionId: string;
  workspaceId?: string;
  userId?: string;
}

export interface MemorySearchOptions {
  scopes: MemoryRecord["binding"]["scope"][];
  limit: number;
  access: MemoryAccessContext;
}

export interface MemoryProposal {
  id: string;
  record: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">;
  sourceTurnId: string;
  createdAt: string;
}

export interface MemoryStore {
  search(query: string, options: MemorySearchOptions): Promise<ReadonlyArray<MemoryRecord>>;
  propose(proposal: MemoryProposal, access: MemoryAccessContext): Promise<MemoryProposal>;
  confirm(proposalId: string, access: MemoryAccessContext): Promise<MemoryRecord>;
  reject(proposalId: string, access: MemoryAccessContext): Promise<void>;
  upsert(record: MemoryRecord, access: MemoryAccessContext): Promise<MemoryRecord>;
  delete(id: string, access: MemoryAccessContext): Promise<void>;
  deleteScope(scope: MemoryRecord["binding"]["scope"], access: MemoryAccessContext): Promise<number>;
}
```

Memory 必须具备稳定 ID、binding、来源、时间戳和过期字段。`project` scope 必须绑定不可变的 `workspaceId`，`user` scope 必须绑定不可变的 `userId`，`session` scope 必须绑定 `sessionId`。Store 在 `search`、提议、确认、写入、删除和清空的每一次操作中都校验 `MemoryAccessContext` 与记录 binding；缺少对应身份时拒绝操作，不能把未提供的身份解释成“所有项目/用户”。因此 ID 本身不是授权凭据，猜到 ID 也不能读取或删除其他主体的记录。

### 5.2 检索、写入和删除

每轮开始时，以本轮最新用户输入为查询词，并按 scope 检索少量相关记录。对于 `run(string)`，查询词就是该字符串；对于 `run(AgentMessage)`，仅当输入角色为 `user` 时，按原有 content 顺序拼接全部 `{ type: "text" }` 片段，并以 `\n` 分隔。没有 text 片段、文本为空，或传入非 `user` 消息时跳过本轮检索，不得回退使用上一条用户消息。注入结果必须包含记录 ID 和来源摘要，且总字符数受上下文预算控制。

每轮结束后，`MemoryExtractor` 可从已确认的用户信息和决策中提出候选记录。它接收 `turnId`、本轮持久化消息、`MemoryAccessContext` 和允许的 scope，返回不含 ID 的候选记录；core 为每项候选分配 proposal ID、调用 `store.propose()` 并写入 `memory.proposed`。宿主通过 `store.confirm(proposalId, access)` 或 `store.reject(proposalId, access)` 处理候选；确认后才调用 `upsert` 并写入 `memory.saved`。基础策略默认“提议后确认”，不自动写入；宿主可设置为仅允许某些 kind 自动保存，但自动保存仍必须经过同一校验和策略授权。`MemoryPolicy` 的最小接口必须显式接收 `{ action: "propose" | "confirm" | "save" | "delete", record, access }`，并返回 allow/deny，避免由 extractor 或 Store 默认为已授权。

- 内容长度、格式和敏感字段检查；
- 基于规范化文本、scope 和 kind 的去重；
- 过期时间与来源完整性校验；
- 用户或宿主策略的授权判定。

用户必须能按 ID 删除单条 Memory，并可清空特定 scope；这两个操作均须传入 `MemoryAccessContext` 并通过 `MemoryPolicy`。删除后 Store 必须在同一提交中删除正文与索引，且不能在后续检索中返回；事件记录保留删除动作的审计信息，但不得继续保留已删除的敏感正文。

### 5.3 初始检索实现

MVP 采用可替换的关键词检索实现，例如 JSONL 索引或 SQLite FTS。检索结果按文本匹配和更新时间排序。向量数据库、embedding 生成、混合检索和重排序通过新的 `MemoryStore` 实现或可选 `MemoryRanker` 接口在后续引入。

## 6. Core 集成点

扩展 `AgentSessionOptions`，但保持现有调用方兼容：

```ts
export interface AgentSessionOptions {
  // existing fields
  skills?: SkillProvider;
  memory?: {
    store: MemoryStore;
    extractor?: MemoryExtractor;
    policy?: MemoryPolicy;
    /** sessionId 由 AgentSession 补齐；project/user Memory 必须由宿主提供对应身份。 */
    access?: Omit<MemoryAccessContext, "sessionId">;
  };
}
```

`AgentSession.drive()` 在用户消息已加入本次 turn、但进入 step 循环之前，调用一个新的 `ExtensionContextResolver`：它接收按 §5.2 规范化的查询词、Skill 元数据、Memory store、由 `sessionId` 与宿主身份组成的 `MemoryAccessContext` 和已注册工具，创建一次 `TurnExtensionContext`。`collectModelResponse()` 在每个 step 将 `this.messages`、`turnContext.injectedMessages` 与 `turnContext.effectiveTools` 分别传给 `ContextManager.prepare(messages, injectedMessages, tools)`；`prepare()` 先在扩展预算内裁剪独立注入数据，再将最终会发送给模型的渲染消息和工具定义一并传给 `estimateTokens`，且不得修改 `AgentSession.messages`。执行工具调用时也必须接收同一个 `turnContext`：注册表中存在但不在冻结的 `effectiveTools` 的名称先返回 `TOOL_DISABLED_BY_SKILL`，再进行 schema 校验和 `PermissionPolicy` 判定。这将“每 turn 一次的决策”和“每 step 的上下文组装”明确分离。

在 `ContextOptions` 中新增 `extensionBudgetTokens?: number` 与 `skillCatalogMaxChars?: number`：前者是目录、Skill 正文和 Memory 合计可占用的 token 上限，后者限制目录渲染的最大字符数；未配置时分别使用实现定义的保守默认值，并在文档和运行时暴露实际默认值。token 估算必须覆盖最终发送的全部历史消息、渲染后的注入消息及工具定义。

上下文组装按硬上限执行：先预留 `maxOutputTokens`，再计算不可裁剪的系统消息、工具定义和当前用户输入；三者已超过窗口时，**不得调用模型**，应以 `CONTEXT_STATIC_OVER_BUDGET` 失败并写入不含正文的预算事件。剩余空间才由 `min(extensionBudgetTokens, remaining)` 分配给扩展上下文；扩展不足时按目录元数据、Skill 正文、Memory 内容的顺序裁剪，并在对应事件中记录裁剪信息。随后压缩较早历史；若压缩后的历史加上最低保留的当前输入仍超限，则以 `CONTEXT_REQUEST_OVER_BUDGET` 失败，而非悄然截断当前用户输入或发送超窗请求。不得把完整 Skill 正文降级为普通 `Conversation summary` 内容。

建议新增以下 Durable Event。turn 内产生的扩展事件必须包含 `{ turnId, at }`；turn 外确认、拒绝或删除产生的事件必须包含 `{ relatedTurnId, at, operationId }`，其中 `relatedTurnId` 是候选或记录的来源回合。`turn.completed`、`turn.interrupted` 与 `turn.failed` 同样必须携带 `turnId`，从而允许不依赖日志位置推断地按回合查询。

- `skill.catalog.presented`：本轮向模型展示的 Skill 元数据；
- `skill.matched`：匹配规则、名称与触发来源；
- `skill.loaded`：实际注入的 Skill 版本和内容摘要；
- `memory.retrieved`：检索条件、返回的记录 ID 与裁剪信息；
- `memory.proposed`、`memory.confirmed`、`memory.rejected`：候选及其处理结果；
- `memory.saved`、`memory.deleted`：持久化变更及记录 ID。

事件只保存必要的摘要、哈希或 ID；Memory 正文是否写入事件存储由宿主的数据保留策略决定。恢复采用**审计性还原**，而非内容性还原：`recoverSession()` 是 `@agent-sdk/storage` 的函数，继续只恢复快照与 `message.appended` 的会话消息。storage 包应新增独立的 `queryExtensionEvents(store, options)` 查询函数（按序号、`turnId`、`relatedTurnId` 和事件类型过滤），而不扩展 `RecoveredSession`；该函数返回上述审计事件以说明此前注入、保存或删除了什么，但不会把旧 turn 的临时 Skill/Memory 注入重新加入消息。恢复后的新 turn 必须按当前配置和当前用户输入重新匹配 Skill、重新检索 Memory。只有未来显式持久化的跨 turn Skill 激活状态才参与内容性恢复。

## 7. 权限与安全边界

1. Skill 从受信根目录加载，路径解析必须拒绝 `..`、符号链接越界和未声明资源。
2. Skill 只影响上下文和工具可见集合，永远不能覆盖会话权限策略。
3. Memory 默认不自动保存；候选内容应过滤凭据、访问令牌、身份证明及高风险个人数据。
4. Memory 检索按 workspace 与用户边界隔离，禁止默认跨 scope 召回。
5. 任何来自工具输出、网页或外部 MCP 的文本均标为不可信；写入 Memory 前必须经过显式策略处理。
6. 为防提示注入，Skill 和 Memory 均以结构化包裹文本注入，说明其来源和适用范围；模型不得将其视为更高优先级指令。
7. 删除 Memory 时要同时删除索引与正文；审计事件不得保留可恢复的敏感内容。

## 8. 分阶段实施

### Phase 1：Skill MVP

- 新建 `packages/skills`，实现 frontmatter 解析、受信目录扫描和 `SkillProvider`。
- 确认 `packages/*` workspace glob 包含 `packages/skills`，并将它加入根 `tsconfig.json` references、根 `build` 脚本及 CJS package 元数据复制列表；为它声明到 core 的单向依赖。
- 在 core 中定义 Skill 类型与可选的 context provider 接口。
- 支持显式 `/skill-name` 和触发词匹配。
- 在 turn 开始构造临时 `TurnExtensionContext`，并在全部 steps 中复用目录及命中的完整 Skill。
- 冻结 `effectiveTools`，实现 `TOOL_DISABLED_BY_SKILL`，并测试多 Skill 的工具并集与未声明 `allowedTools` 的语义。
- 添加加载、覆盖优先级、路径越界、预算裁剪、跨 step 复用和历史压缩隔离的单元测试。

### Phase 2：Memory MVP

- 新建 `packages/memory`，实现 `MemoryStore` 及 JSONL 或 SQLite FTS 后端。
- 确认 `packages/*` workspace glob 包含 `packages/memory`，并将它加入根 `tsconfig.json` references、根 `build` 脚本及 CJS package 元数据复制列表；为它声明到 core 的单向依赖。
- 支持检索注入、带访问上下文的候选提议、人工确认/拒绝、按 ID 删除与按 scope 清空。
- 接入 workspace/scope 隔离和敏感信息过滤。
- 为检索、提议和变更写入 Durable Event。
- 添加跨 session 检索、去重、过期和删除不可检索的集成测试。
- 添加 workspace/user 越权读取与删除、缺少身份拒绝、候选确认/拒绝和外部操作审计关联的集成测试。

### Phase 3：生产化与增强

- 支持用户/项目 Skill 目录与冲突诊断。
- 增加语义匹配、embedding 检索及可插拔重排序。
- 支持 Memory 生命周期策略、批量管理 API 和可观测指标。
- 为 Skill 更新、Memory 删除、权限拒绝与会话恢复增加端到端测试。

## 9. 验收标准

首个可发布版本必须满足：

1. 宿主目录中的 `SKILL.md` 可被发现并以元数据形式展示给模型。
2. 用户显式指定或触发词命中 Skill 时，完整正文仅在该回合被注入。
3. 活跃 Skill 不能使未注册工具可见，也不能放宽任何权限决策。
4. 用户确认的一条 project Memory 能在新建 session 中被检索并携带来源 ID。
5. 删除的 Memory 不再可检索，且事件中不保留其敏感正文。
6. Skill/Memory 发生注入、保存和删除时，事件回放能审计其来源与影响；恢复后的新 turn 不复用旧 turn 的临时注入内容。
7. 未配置 `skills` 与 `memory` 时，现有 `AgentSession` 行为和公共 API 保持不变。
8. 跨 workspace 或 user 的读取、确认、保存、删除和清空均被拒绝；记录 ID 不能充当授权凭据。
9. 系统消息、工具定义、当前用户输入和输出预留已超出窗口时不会请求模型，并产生可审计但不泄露正文的失败事件。
10. `pnpm build` 会构建并生成 `@agent-sdk/skills` 与 `@agent-sdk/memory` 的 ESM/CJS 发布物。

## 10. 推荐实施顺序

先完成 context provider 抽象与 Skill MVP，再引入 Memory MVP。Skill 的数据流单向且不涉及跨会话持久化，适合用来验证上下文预算、来源标记和事件模型；Memory 则在这些边界稳定后接入，可减少隐私与恢复逻辑的返工。
