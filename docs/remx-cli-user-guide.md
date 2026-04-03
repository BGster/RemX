# RemX CLI 用户手册

RemX v2 — 命令行工具完整参考。

---

## 基础概念

| 术语 | 含义 |
|------|------|
| **memory** | 一个文件在系统中的唯一记录，含元数据 + chunks |
| **chunk** | 按 heading 层级切分的语义单元，含 content_hash 用于增量索引 |
| **decay** | 记忆衰减：`tmp` 类 TTL 过期后被 GC 清理；`demand/issue` 类按 stale_after 变旧但不自动删除 |
| **content_hash** | chunk 内容的 SHA256 前16位，re-index 时内容未变则跳过 embedding |
| **语义检索** | `--query` 触发向量检索，按 `cosine × decay_weight` 排序 |

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
remx init --reset --db ./pm.db --meta ./meta.yaml
```

---

## remx index

索引单个文件到数据库。幂等操作：同一文件重复索引会复用已有 chunk 向量（按 content_hash）。

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
| `--dedup-threshold <float>` | 开启跨文件语义去重（cosine 阈值，如 0.95）|

**示例：**
```bash
# 索引项目文件
remx index demands/feature-A.md --db ./pm.db --meta ./meta.yaml

# 重复索引（内容不变时跳过 embedding）
remx index demands/feature-A.md --db ./pm.db --meta ./meta.yaml
# 输出: [remx] write_memory: reused 3/4 chunk vectors (content hash match)

# 语义去重警告（knowledge/principle 文件）
remx index knowledge/new-principle.md --db ./pm.db --meta ./meta.yaml --dedup-threshold 0.95

# 无向量服务时
remx index demands/feature-A.md --db ./pm.db --meta ./meta.yaml --no-embed
```

**输出说明：**
```
remx index: indexed demands/feature-A.md
  memory_id: DEM-2CA42DFCEA5079B7
  category: demand
  chunks: 4
  expires_at: 2026-07-02T10:00:00+00:00
```

**内置衰减默认值**（meta.yaml 无显式配置时生效）：

| category | 默认衰减 |
|----------|---------|
| tmp | ttl=24h |
| demand | stale_after=90d |
| issue | stale_after=60d |
| knowledge / principle | never（无衰减）|

**chunk_id 格式：**
- 项目文件：`project::{relative_path}::{chunk_index}`
  - 例：`project::demands/feature-A.md::0`
- 全局文件：`global::{display_path}::{chunk_index}`

---

## remx retrieve

按过滤器和/或语义查询检索记忆。

```bash
remx retrieve [--filter '<json>'] [--query '<text>'] [--db <path>] [options]
```

| 参数 | 说明 |
|------|------|
| `--filter '<json>'` | JSON 过滤条件（可选，与 --query 组合）|
| `--query '<text>'` | 自然语言语义检索（触发向量模式）|
| `--db <path>` | 数据库路径 |
| `--meta <path>` | meta.yaml 路径（语义模式必需）|
| `--no-content` | 不返回 chunk 内容（只返回 memory 记录）|
| `--limit <n>` | 最大返回条数（默认 50）|
| `--decay-weight <float>` | 衰减权重 0.0-1.0（0=纯相似度，1=纯衰减因子，默认 0.5）|
| `--no-embed` | 跳过 embedding（只能用于 filter 模式）|

**filter 支持的字段：**

| 字段 | 示例 |
|------|------|
| category | `{"category": "demand"}` |
| priority | `{"priority": "P1"}` |
| status | `{"status": "open"}` |
| file_path | `{"file_path": "demands/feature-A.md"}` |
| deprecated | `{"deprecated": 0}` |
| expires_at | `{"expires_at": {"<": "2026-04-01T00:00:00Z"}}` |

**语义检索得分公式：**
```
score = (1 - decay_weight) × cosine_similarity + decay_weight × decay_factor

decay_factor:
  - never / 无 decay_group: 1.0
  - ttl: 剩余时间 / ttl_hours（线性衰减到 0）
  - stale_after: 超过宽限期后指数衰减 exp(-rate × (days_since - grace_days))
```

**示例：**
```bash
# 纯过滤（无向量服务）
remx retrieve --filter '{"category": "demand"}' --db ./pm.db --no-embed

# 语义搜索（需要 embedder）
remx retrieve --query "认证模块是怎么实现的" --db ./pm.db --meta ./meta.yaml

# 语义搜索，偏重衰减因子（更关注活跃记忆）
remx retrieve --query "登录流程" --db ./pm.db --meta ./meta.yaml --decay-weight 0.8

# 过滤 + 语义组合
remx retrieve --filter '{"category": "issue", "status": "open"}' --query "登录失败" --db ./pm.db --meta ./meta.yaml

# 查已过期记忆
remx retrieve --filter '{"expires_at": {"<": "2026-04-01T00:00:00Z"}}' --db ./pm.db
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
remx gc --db ./pm.db --dry-run

# 执行软删除（标记 deprecated=1）
remx gc --db ./pm.db

# 物理删除所有已标记的记录
remx gc --db ./pm.db --purge

# 只清理某路径
remx gc --db ./pm.db --scope demands/
```

---

## remx stats

数据库健康检查，输出统计信息。

```bash
remx stats --db <path> --meta <meta.yaml>
```

**示例输出：**
```
memories:  42  demand=15  issue=12  tmp=8  knowledge=7
chunks:    186
deprecated: 3 (7.1%)
db size:   2.4 MB
oldest:    2026-03-01   newest: 2026-04-03
  decay groups: tmp_ttl(ttl=24h)  demand_stale(stale_after=90d)
```

---

## remx parse

验证并输出 meta.yaml 结构。

```bash
remx parse [--stdin] <meta.yaml>
```

**示例：**
```bash
remx parse meta.yaml
# 输出格式化 JSON，若有错误则返回非零退出码
```

---

## remx version

```bash
remx version
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

decay_groups:
  - name: tmp_ttl
    trigger:
      category: tmp
    function: ttl
    params:
      ttl_hours: 24
  - name: demand_stale
    trigger:
      category: demand
    function: stale_after
    params:
      days: 90          # 距上次更新 90 天后开始衰减

# 内置默认衰减（可不配置）：
#   tmp         → ttl=24h
#   demand      → stale_after=90d
#   issue       → stale_after=60d
#   knowledge   → never
#   principle   → never

vector:
  dimensions: 768

chunk:
  strategy: heading      # "heading" | "paragraph"
  max_tokens: 512
  overlap: 1
  heading_levels: [1, 2, 3]

embedder:
  provider: ollama        # ollama | openai | azure
  model: bge-m3
  base_url: http://localhost:11434
  timeout: 60
```

---

## 文件 front-matter 约定

```markdown
---
category: demand        # 必填：demand | issue | tmp | knowledge | principle
priority: P1           # 可选：P0/P1/P2
status: open          # 可选：open | in_progress | closed
type: bug             # 可选：任意字符串
created_at: "2026-04-01T10:00:00+00:00"  # 可选，默认当前时间
---
# 标题

内容...
```

---

## 工作流示例

**完整工作流：**
```bash
# 1. 初始化
remx init --reset --db ./pm.db --meta ./meta.yaml

# 2. 写一条决策记忆
cat > demands/auth-decision.md << 'EOF'
---
category: demand
priority: P1
status: open
---
# 认证模块决策

## 方案
使用 JWT Token。

## 结论
采用 JWT。
EOF

# 3. 索引
remx index demands/auth-decision.md --db ./pm.db --meta ./meta.yaml

# 4. 检索
remx retrieve --filter '{"category": "demand"}' --db ./pm.db --no-embed

# 5. 语义搜索
remx retrieve --query "认证方案" --db ./pm.db --meta ./meta.yaml

# 6. 检查健康
remx stats --db ./pm.db --meta ./meta.yaml

# 7. GC 清理
remx gc --db ./pm.db --dry-run
remx gc --db ./pm.db
```
