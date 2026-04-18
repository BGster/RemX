---
name: remx-skill
description: RemX 项目记忆管理工具的 OpenClaw Skill 封装。
---

# RemX Skill

项目记忆管理工具的 OpenClaw Skill 封装。

## 定位

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心概念

| 概念 | 说明 |
|------|------|
| **memory** | 一个文件的唯一记录，含元数据 + 多个 chunk |
| **chunk** | 按标题层级切分的语义单元，每个 H1/H2/H3 是一个 chunk |
| **content_hash** | chunk 内容的 SHA256 前16位；re-index 时内容不变则跳过 embedding |
| **decay** | 配了 decay_group 的记忆按 TTL/stale_after 自动衰减；never 类永不过期 |
| **语义检索** | `--query` 触发向量检索，按 `cosine_similarity × decay_factor` 排序 |
| **拓扑关系** | 记忆之间的因果/相关性连接，支持上下文感知的图遍历召回 |

## 内置衰减默认值

meta.yaml 无显式配置时自动应用：

| category | 默认衰减 | 说明 |
|----------|---------|------|
| tmp | ttl=24h | 临时笔记 |
| demand | stale_after=90d | 设计决策 |
| issue | stale_after=60d | 问题/bug |
| knowledge | never | 知识积累 |
| principle | never | 原则规范 |

## CLI 命令（8个）

| 命令 | 功能 |
|------|------|
| `remx init` | 初始化/重建数据库 |
| `remx index` | 索引单个文件（含 --dedup-threshold 语义去重）|
| `remx retrieve` | 过滤/语义检索（--query --decay-weight）|
| `remx gc` | 软删除过期 + 物理清理 deprecated |
| `remx stats` | 数据库健康统计 |
| `remx parse` | 验证 meta.yaml |
| `remx relate` | 拓扑关系管理（节点/关系增删查/图遍历/语义扩展）|
| `remx version` | 输出版本 |

完整用法见 `references/remx-cli-user-guide.md`。

## Skill 组件（modules/）

| 组件 | 职责 |
|------|------|
| **MemoryFileManager** | 写 / 更新 / 删除记忆文件，联动 remx index |
| **ChunkSplitter** | 验证 heading 结构，预览切分结果 |
| **ContextAssembler** | 检索记忆并组装成 LLM 可用的上下文 |
| **DecayWatcher** | 检查衰减阈值，对快到期的记忆发出提醒 |

详细接口文档 → `modules/`。

## 拓扑关系（Topology）

RemX 通过拓扑关系将相关记忆连接成图，实现上下文感知的图遍历召回。

### 核心概念

| 概念 | 说明 |
|------|------|
| **memory_node** | 一条记忆的图节点，含 id/category/chunk |
| **memory_relation** | 关系记录，含 rel_type/context/description |
| **memory_relation_participants** | 参与者的角色（cause/effect/component/whole/related/opponent）|
| **context** | 上下文标签，NULL=全局无条件匹配 |
| **topology_aware_recall** | 拓扑增强检索：语义结果经 BFS 图扩展，发现语义未命中但结构相关的信息 |

### 支持的关系类型

| rel_type | 说明 |
|----------|------|
| `因果关系` | A 导致 B |
| `相关性` | A 与 B 相关 |
| `对立性` | A 与 B 对立 |
| `流程顺序性` | A 在 B 之前/之后 |
| `组成性` | A 是 B 的组件 / B 是 A 的整体 |
| `依赖性` | A 依赖 B |

### Context 过滤机制

relation 的 context 决定何时可用：
- `NULL`（全局）→ 所有上下文都匹配
- `group_chat` → 仅在 `group_chat` 上下文中匹配
- `main_session` → 仅在 `main_session` 上下文中匹配

检索时传入 `--current-context` 参数按上下文过滤。

**匹配规则（`match_context`）：**
```python
def match_context(relation_context: Optional[str], current: Optional[str]) -> bool:
    if relation_context is None or relation_context == DEFAULT_CONTEXT:
        return True   # NULL 或 "global" → 全局无条件匹配
    return relation_context == current  # 精确匹配上下文标签
```

**示例：**
| relation.context | current_context | 结果 |
|-----------------|-----------------|------|
| `NULL` | `main_session` | ✅ 匹配（全局）|
| `NULL` | `group_chat` | ✅ 匹配（全局）|
| `global` | 任意 | ✅ 匹配（全局）|
| `main_session` | `main_session` | ✅ 匹配 |
| `main_session` | `group_chat` | ❌ 不匹配 |
| `group_chat` | `main_session` | ❌ 不匹配 |

### 拓扑增强的语义检索（topology_aware_recall）

语义搜索找到的是字面相关记忆；拓扑扩展在此基础上，通过关系图发现语义未命中但结构相关的信息。

**算法流程：**
1. 语义搜索返回一批命中结果（每条含 `id` 或 `memory_id`）
2. 对每个命中节点执行 BFS 图遍历（默认 2 跳），收集可达节点
3. 去重后最多返回 10 条拓扑扩展结果（均标记 `source: "topology"`）

**使用方式：**
```bash
# 语义搜索 → 拓扑扩展管道
remx retrieve --query "认证模块" --db ./memory.db --meta ./meta.yaml > base.json
cat base.json | remx relate expand --db ./memory.db --current-context main_session
```

**扩展参数：**
- `--max-depth`：BFS 最大深度（默认 2，值越大范围越广但噪声越多）
- `--max-additional`：最多扩展多少条拓扑结果（默认 10）

**返回格式差异：**
- 语义命中：`{id, category, chunk, score}`
- 拓扑扩展：`{id, category, chunk, source: "topology", depth: N}`

### 使用场景

- **因果链追溯**：`remx relate graph --node-id <A> --max-depth 3` 追溯 A 导致 B 导致 C
- **跨记忆关联**：两条原本独立的需求有共同的底层依赖，拓扑连接后一次检索全部召回
- **上下文隔离**：group_chat 中的关系不对 main_session 暴露
- **语义盲区补充**：某记忆在向量空间中与查询距离远，但通过拓扑图直接相连，扩展检索可命中

## 拓扑模块 Python API

`remx.core.topology` 导出以下公共函数，可直接调用：

| 函数 | 说明 |
|------|------|
| `ensure_node(db_path, node_id, category, chunk)` | 插入或忽略一个节点（幂等） |
| `list_nodes(db_path, category=None)` | 列出节点，可按 category 过滤 |
| `insert_relation(db_path, rel_type, node_ids, roles, context=None, description=None)` | 原子插入关系 + 参与者 |
| `delete_relation(db_path, relation_id)` | 删除关系（级联删除参与者） |
| `query_relations(db_path, node_id, current_context=None)` | 查询某节点所有关系（含上下文过滤） |
| `get_related_nodes(db_path, node_id, current_context=None, max_depth=2)` | BFS 图遍历，返回可达节点图 |
| `topology_aware_recall(db_path, base_results, current_context=None, max_depth=2, max_additional=10)` | 语义结果 + 拓扑扩展合并 |
| `match_context(relation_context, current)` | 判断某条 relation 是否在当前上下文可用 |

**使用示例：**
```python
from pathlib import Path
from remx.core.topology import insert_relation, topology_aware_recall

db = Path("memory.db")

# 建立因果链
insert_relation(db, "因果关系", ["DEM-001", "DEM-002"], ["cause", "effect"])
insert_relation(db, "因果关系", ["DEM-002", "DEM-003"], ["cause", "effect"])

# 程序化拓扑扩展检索
base = [{"id": "DEM-001", "chunk": "...", "category": "demand"}]
expanded = topology_aware_recall(db, base, current_context="main_session", max_depth=2)
# expanded 包含语义命中 + 拓扑扩展节点，拓扑节点标记 source="topology"
```

## 记忆书写规范

详见 `references/memory-writing-guide.md`，核心规则：

- **分块**：每个 chunk 最大 360 字（约 H1-H3 一个章节）
- **链接**：关联记忆末尾添加双向链接 `标题1 <--> 标题2`
- **稀疏链接**：仅严格依赖关系才链接，避免全连接
- **中转块**：功能记忆块链接超过 3 条时，通过中转记忆块组织

## 快速开始

```bash
# 初始化
remx init --reset --db ./memory.db --meta ./meta.yaml

# 索引
remx index <file> --db ./memory.db --meta ./meta.yaml

# 检索
remx retrieve --filter '{"category": "demand"}' --db ./memory.db --no-embed

# 语义搜索
remx retrieve --query "认证模块是怎么实现的" --db ./memory.db --meta ./meta.yaml --decay-weight 0.5

# 拓扑关系：建立两条记忆的因果关系
remx relate insert --node-id <id1>,<id2> --rel-type 因果关系 --roles cause,effect --context main_session

# 拓扑关系：查看某记忆的关联图
remx relate graph --node-id <id> --db ./memory.db

# 健康检查
remx stats --db ./memory.db --meta ./meta.yaml
```

## Skill 协作流程

```
用户/Agent 说"记住这个决定"
  → ChunkSplitter.validate() — 检查 heading 结构
  → MemoryFileManager.write() — 写文件 + front-matter + remx index
  → DecayWatcher.check() — 检查衰减，快到期则提醒

用户/Agent 说"我之前关于 X 的决定是什么"
  → ContextAssembler.assemble() — remx retrieve → 组装上下文 → 返回

用户/Agent 说"项目状态怎么样"
  → ContextAssembler.by_filter({category: "demand", status: "open"})
  → DecayWatcher.check() — 报告快过期记忆

用户/Agent 说"这两条记忆有什么关系"
  → remx relate query --node-id <id> --current-context <ctx>
  → 返回拓扑关系列表

用户/Agent 说"语义检索并扩展拓扑"
  → remx retrieve --query "..." | remx relate expand --current-context <ctx>
  → 语义结果 + 拓扑扩展结果合并返回
```

## 触发时机

| 场景 | 操作 |
|------|------|
| 用户做了技术决策 | 写一条 `demand` 记忆 |
| 发现了一个问题 | 写一条 `issue` 记忆 |
| 临时想法/会议记录 | 写一条 `tmp` 记忆（自动 24h 后衰减）|
| 重要知识积累 | 写一条 `knowledge` 记忆（永不过期）|
| 需要回顾项目上下文 | `ContextAssembler` 检索相关记忆 |
| 每次索引新文件后 | `DecayWatcher` 检查衰减阈值，提醒清理 |
| 发现两条记忆有关联 | `remx relate insert` 建立拓扑关系 |
| 需要程序化操作拓扑 | 直接调用 `remx.core.topology` Python API |

## 配置

主要配置在 `meta.yaml`，参考 `references/remx-cli-user-guide.md#metayaml-配置参考`。

关键项：
- `index_scope` — 定义哪些路径算项目记忆
- `decay_groups` — 定义各类记忆的衰减规则（TTL / stale_after / never）
- `chunk.strategy` — `heading`（默认）或 `paragraph`
- `embedder` — 向量嵌入配置（用于语义检索）
