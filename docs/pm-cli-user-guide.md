# PM CLI 用户指南

Project-Manager v2 — 命令行工具参考手册。

---

## 基础概念

| 术语 | 含义 |
|------|------|
| **memory** | 一个文件在系统中的唯一记录，含元数据 + chunks |
| **chunk** | 段落级索引单元，每个文件可切成多个 chunk |
| **global memory** | 路径以 `~` 或 `/` 开头，不属于任何项目 |
| **project memory** | 在 `index_scope` 内的文件，按相对路径索引 |
| **decay** | 记忆衰减：TMP 类文件有 TTL，过期后被 GC 清理 |

---

## pm init

初始化或重建数据库。

```bash
pm init --reset --db <path> --meta <meta.yaml>
```

| 参数 | 说明 |
|------|------|
| `--reset` | 重建所有表（会清空已有数据）|
| `--db <path>` | 数据库文件路径（默认 `memory.db`）|
| `--meta <path>` | meta.yaml 路径（默认当前目录）|

**示例：**
```bash
pm init --reset --db ./pm.db --meta ./meta.yaml
```

---

## pm index

索引单个文件到数据库。

```bash
pm index <file> --db <path> --meta <meta.yaml> [options]
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

**示例：**
```bash
# 索引项目文件
pm index demands/feature-A.md --db ./pm.db --meta ./meta.yaml

# 索引全局记忆（~ 或 / 开头）
pm index ~/notes/idea.md --db ./pm.db --meta ./meta.yaml

# 无向量服务时
pm index demands/feature-A.md --db ./pm.db --meta ./meta.yaml --no-embed
```

**输出说明：**
```
pm index: indexed demands/feature-A.md
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

## pm parse

验证并输出 meta.yaml 结构。

```bash
pm parse <meta.yaml>
```

**示例：**
```bash
pm parse meta.yaml
# 输出格式化 JSON，若有错误则返回非零退出码
```

---

## pm retrieve

按过滤器检索记忆。

```bash
pm retrieve --db <path> --filter '<json>' [options]
```

| 参数 | 说明 |
|------|------|
| `--db <path>` | 数据库路径 |
| `--filter '<json>'` | JSON 格式过滤条件 |
| `--no-content` | 不返回 chunk 内容（只返回 memory 记录）|
| `--limit <n>` | 最大返回条数（默认 50）|

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
pm retrieve --db ./pm.db --filter '{"category": "demand"}'

# 查 P0 且 open 的 issue
pm retrieve --db ./pm.db --filter '{"category": "issue", "priority": "P0", "status": "open"}'

# 查已过期的记忆
pm retrieve --db ./pm.db --filter '{"expires_at": {"<": "2026-04-01T00:00:00Z"}}'
```

**返回格式：** JSON 数组，每条记录含 memory 字段 + 对应 chunk 内容。

---

## pm gc

GC 清理 — 软删除过期记忆或物理删除已标记的记录。

```bash
pm gc --db <path> [--dry-run] [--purge] [--scope <path>]
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
pm gc --db ./pm.db --dry-run

# 执行软删除（标记 deprecated=1）
pm gc --db ./pm.db

# 物理删除所有已标记的记录
pm gc --db ./pm.db --purge

# 只清理某路径
pm gc --db ./pm.db --scope demands/
```

**Skill 提醒阈值（超过任一则提示用户）：**
- `deprecated` 记录占比 > 20%
- `deprecated` 记录总数 > 1000
- 数据库文件 > 50MB

---

## pm version

```bash
pm version
```
输出版本号。

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
