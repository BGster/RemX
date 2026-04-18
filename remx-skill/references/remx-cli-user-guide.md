# RemX CLI 用户指南

RemX v2 — 命令行工具参考手册。

---

## 基础概念

| 术语 | 含义 |
|------|------|
| **memory** | 一个文件在系统中的唯一记录，含元数据 + chunks |
| **chunk** | 段落级索引单元，每个文件可切成多个 chunk |
| **global memory** | 路径以 `~` 或 `/` 开头，不属于任何项目 |
| **project memory** | 在 `index_scope` 内的文件，按相对路径索引 |
| **decay** | 记忆衰减：TMP 类文件有 TTL，过期后被 GC 清理 |
| **topology** | 记忆之间的拓扑关系，支持上下文感知的图遍历召回 |

---

## remx init

初始化或重建数据库。

```bash
remx init --reset --db <path> --meta <meta.yaml>
```

| 参数 | 说明 |
|------|------|
| `--reset` | 重建所有表（会清空已有数据）|
| `--db <path>` | 数据库文件路径（默认 `memory.db`）|
| `--meta <path>` | meta.yaml 路径（默认当前目录）|

**示例：**
```bash
remx init --reset --db ./memory.db --meta ./meta.yaml
```

---

## remx index

索引单个文件到数据库。

```bash
remx index <file> --db <path> --meta <meta.yaml> [options]
```

| 参数 | 说明 |
|------|------|
| `<file>` | 要索引的文件路径 |
| `--db <path>` | 数据库路径 |
| `--meta <path>` | meta.yaml 路径 |
| `--no-embed` | 跳过向量生成（无 embedding 服务时使用）|
| `--chunk-size <n>` | 每个 chunk 的段落数（0=按 meta.yaml）|
| `--overlap <n>` | 相邻 chunk 重叠段落数 |
| `--max-tokens <n>` | 最大 token 数 |
| `--dedup-threshold <float>` | 语义去重阈值（cosine similarity，如 0.95）|

**示例：**
```bash
# 索引项目文件
remx index demands/feature-A.md --db ./memory.db --meta ./meta.yaml

# 索引全局记忆（~ 或 / 开头）
remx index ~/notes/idea.md --db ./memory.db --meta ./meta.yaml

# 无向量服务时
remx index demands/feature-A.md --db ./memory.db --meta ./meta.yaml --no-embed

# 语义去重（knowledge/principle 类别）
remx index knowledge/new-principle.md --db ./memory.db --meta ./meta.yaml --dedup-threshold 0.95
```

**输出说明：**
```
remx index: indexed demands/feature-A.md
  memory_id: DEM-2CA42DFCEA5079B7
  category: demand
  chunks: 4           ← 该文件被切成 4 个 chunk
  expires_at: null    ← 永不过期（demand 类无 decay 规则）
```

**chunk_id 格式：**
- 项目文件：`project::{relative_path}::{chunk_index}`
  - 例：`project::demands/feature-A.md::0`
- 全局文件：`global::{display_path}::{chunk_index}`
  - 例：`global::~/notes/idea.md::0`

---

## remx parse

验证并输出 meta.yaml 结构。

```bash
remx parse <meta.yaml>
```

**示例：**
```bash
remx parse meta.yaml
# 输出格式化 JSON，若有错误则返回非零退出码
```

---

## remx retrieve

按过滤器检索记忆，支持过滤模式和语义搜索模式。

```bash
remx retrieve --db <path> [--filter '<json>'] [--query '<text>'] [options]
```

| 参数 | 说明 |
|------|------|
| `--db <path>` | 数据库路径 |
| `--filter '<json>'` | JSON 格式过滤条件 |
| `--query '<text>'` | 自然语言查询，触发向量语义搜索 |
| `--meta <path>` | meta.yaml 路径（语义搜索时必需）|
| `--no-content` | 不返回 chunk 内容（只返回 memory 记录）|
| `--no-embed` | 跳过 embedding（只能与 `--filter` 搭配）|
| `--limit <n>` | 最大返回条数（默认 50）|
| `--decay-weight <0.0-1.0>` | 衰减因子权重（默认 0.5）|

**filter 支持的字段：**

| 字段 | 示例 |
|------|------|
| category | `{"category": "demand"}` |
| priority | `{"priority": "P1"}` |
| status | `{"status": "open"}` |
| file_path | `{"file_path": "demands/feature-A.md"}` |
| deprecated | `{"deprecated": 0}` |
| expires_at | `{"expires_at": {"<": "2026-04-01T00:00:00Z"}}` |

**示例：**
```bash
# 查所有 demand
remx retrieve --db ./memory.db --filter '{"category": "demand"}'

# 查 P0 且 open 的 issue
remx retrieve --db ./memory.db --filter '{"category": "issue", "priority": "P0", "status": "open"}'

# 语义搜索
remx retrieve --db ./memory.db --query "认证模块是怎么实现的" --meta ./meta.yaml

# 语义搜索（衰减权重更高，向量权重更低）
remx retrieve --db ./memory.db --query "登录流程" --meta ./meta.yaml --decay-weight 0.8

# 组合：过滤 + 语义搜索
remx retrieve --db ./memory.db --filter '{"category": "issue", "status": "open"}' --query "登录失败" --meta ./meta.yaml

# 查已过期
remx retrieve --db ./memory.db --filter '{"expires_at": {"<": "2026-04-01T00:00:00Z"}}'
```

**返回格式：** JSON 数组，每条记录含 memory 字段 + 对应 chunk 内容。

---

## remx relate

管理记忆之间的拓扑关系（节点、关系增删查、BFS 图遍历、语义扩展）。

```bash
remx relate <action> --db <path> [options]
```

**actions:**

| action | 说明 |
|--------|------|
| `nodes` | 列出所有拓扑节点 |
| `insert` | 插入一条关系 |
| `delete` | 删除一条关系 |
| `query` | 查询某节点的所有关系 |
| `graph` | BFS 图遍历，查看某节点的拓扑子图 |
| `expand` | 从语义结果出发，通过拓扑扩展更多相关记忆 |

### remx relate insert

```bash
remx relate insert --node-id <id1,id2,...> --rel-type <类型> --db <path> \
    [--roles <role1,role2,...>] [--context <ctx>] [--description <text>]
```

**关系类型（`--rel-type`）：**
- `因果关系` — A 导致 B
- `相关性` — A 与 B 相关
- `对立性` — A 与 B 对立
- `流程顺序性` — A 在 B 之前/之后
- `组成性` — A 是 B 的组件 / B 是 A 的整体
- `依赖性` — A 依赖 B

**角色（`--roles`）：**
- `cause` — 因（导致方）
- `effect` — 果（被导致方）
- `component` — 组件
- `whole` — 整体
- `related` — 相关（对称关系用）
- `opponent` — 对立（对称关系用）

**示例：**
```bash
# 建立因果关系（两个节点，第一个是 cause，第二个是 effect）
remx relate insert --node-id DEM-001,DEM-002 --rel-type 因果关系 --roles cause,effect --db ./memory.db

# 建立多节点关系
remx relate insert --node-id DEM-001,DEM-002,DEM-003 --rel-type 流程顺序性 --roles cause,effect,effect --db ./memory.db

# 带上下文（仅在 main_session 上下文中可见）
remx relate insert --node-id DEM-001,DEM-002 --rel-type 相关性 --context main_session --db ./memory.db
```

### remx relate delete

```bash
remx relate delete --node-id <relation_id> --db <path>
```

**示例：**
```bash
# 删除关系 ID=5
remx relate delete --node-id 5 --db ./memory.db
```

### remx relate query

```bash
remx relate query --node-id <entry_id> --db <path> [--current-context <ctx>]
```

按节点 ID 查询所有关联关系，支持上下文过滤。

**示例：**
```bash
remx relate query --node-id DEM-001 --db ./memory.db --current-context main_session
```

### remx relate graph

```bash
remx relate graph --node-id <entry_id> --db <path> \
    [--max-depth <n>] [--current-context <ctx>]
```

BFS 图遍历，返回该节点的可达拓扑子图。

**示例：**
```bash
remx relate graph --node-id DEM-001 --db ./memory.db --max-depth 3
```

### remx relate nodes

```bash
remx relate nodes --db <path> [--limit <n>]
```

列出所有拓扑节点。

**示例：**
```bash
remx relate nodes --db ./memory.db --limit 100
```

### remx relate expand

从语义搜索结果出发，通过拓扑扩展更多相关记忆。

```bash
cat semantic_results.json | remx relate expand --db <path> \
    [--current-context <ctx>] [--max-depth <n>] [--max-additional <n>]
```

**示例：**
```bash
# 语义搜索结果拓扑扩展
remx retrieve --query "认证模块" --db ./memory.db --meta ./meta.yaml > base.json
cat base.json | remx relate expand --db ./memory.db --current-context main_session --max-additional 10
```

---

## remx gc

GC 清理 — 软删除过期记忆或物理删除已标记的记录。

```bash
remx gc --db <path> [--dry-run] [--purge] [--scope <path>]
```

| 参数 | 说明 |
|------|------|
| `--dry-run` | 预览要清理的记录，不实际删除 |
| `--purge` | 物理删除已 deprecated 的记录（不可逆）|
| `--scope <path>` | 只清理指定路径下的记录 |
| `--db <path>` | 数据库路径 |

**示例：**
```bash
# 预览要清理的记录
remx gc --db ./memory.db --dry-run

# 执行软删除（标记 deprecated=1）
remx gc --db ./memory.db

# 物理删除所有已标记的记录
remx gc --db ./memory.db --purge

# 只清理某路径
remx gc --db ./memory.db --scope demands/
```

**Skill 提醒阈值（超过任一则提示用户）：**
- `deprecated` 记录占比 > 20%
- `deprecated` 记录总数 > 1000
- 数据库文件 > 50MB

---

## remx stats

显示数据库健康统计。

```bash
remx stats --db <path> [--meta <path>]
```

**示例：**
```bash
remx stats --db ./memory.db --meta ./meta.yaml
```

**输出示例：**
```
memories:  42  demand=12  issue=8  knowledge=15  tmp=7
chunks:    156
deprecated: 3 (7.1%)
db size:   2.3 MB
topology:  28 nodes  35 relations
  因果关系: 12
  相关性: 18
  组成性: 5
```

---

## remx version

```bash
remx version
```
输出版本号。

---

## 完整工作流示例

```bash
# 初始化
remx init --reset --db ./memory.db --meta ./meta.yaml

# 索引项目记忆
remx index demands/auth-decision.md --db ./memory.db --meta ./meta.yaml
remx index issues/login-bug.md --db ./memory.db --meta ./meta.yaml

# 检索
remx retrieve --filter '{"category": "demand"}' --db ./memory.db --no-embed
remx retrieve --query "认证方案" --db ./memory.db --meta ./meta.yaml

# 建立拓扑关系
remx relate insert --node-id DEM-001,DEM-002 --rel-type 因果关系 --roles cause,effect --context main_session --db ./memory.db

# 图遍历查看关联
remx relate graph --node-id DEM-001 --db ./memory.db --max-depth 3

# 健康检查
remx stats --db ./memory.db --meta ./meta.yaml

# GC 清理
remx gc --db ./memory.db --dry-run
remx gc --db ./memory.db
```

---

## meta.yaml 配置参考

```yaml
name: my-project
version: "1"

index_scope:
  - path: "demands/"      # 相对路径 = 项目记忆
    pattern: "*.md"
  - path: "issues/"
    pattern: "*.md"
  - path: "~/notes/"       # ~ 开头 = 全局记忆
    pattern: "*.md"

dimensions:
  normal:
    - name: category
      values: [demand, issue, tmp]
    - name: priority
      values: [P0, P1, P2]
    - name: status
      values: [open, in_progress, closed]
  decay:
    - name: category
      values: [tmp]

decay_groups:
  - name: tmp_ttl
    trigger:
      category: tmp
    function: ttl
    params:
      ttl_hours: 1
    apply_fields: [created_at, expires_at]

vector:
  dimensions: 3

chunk:
  strategy: heading      # "heading" | "paragraph"
  max_tokens: 512
  overlap: 1            # 重叠段落数（非 token）
  heading_levels: [1, 2, 3]
```

---

## 文件 front-matter 约定

```markdown
---
category: demand        # 必填：demand | issue | tmp
priority: P1           # 可选：P0/P1/P2
status: open          # 可选：open | in_progress | closed
type: bug             # 可选：任意字符串
created_at: "2026-04-01T10:00:00Z"  # 可选，默认当前时间
---
# 标题

内容...
```

---
