# RemX v2 设计方案

## 核心理念

**数据驱动架构**：所有业务逻辑通过 `meta.yaml` 配置定义，CLI 仅执行索引引擎和检索，Skill 是唯一的协调层。

**当前僵化方案** 作为参考范式（`docs/reference-v1.md`），记录从硬编码到完全可配置的设计演进。

---

## 架构分层

```
┌─────────────────────────────────────────────────────┐
│                    用户交互层                          │
│         Skill（协调层，CLI 的唯一调用方）              │
│  - 解析 meta.yaml / meta.md                         │
│  - 理解用户意图                                     │
│  - 组装结构化操作                                   │
│  - 维护文件（切割/更新/查找 chunk）                 │
└────────────────┬────────────────────────────────────┘
                 │ 结构化 JSON / CLI 命令
┌────────────────▼────────────────────────────────────┐
│                   CLI 引擎层                         │
│  parse  │  init  │  index  │  gc  │  retrieve      │
│                                                         │
│  职责：                                                │
│  - 解析 meta.yaml，建表/重建表                       │
│  - 索引文件（写 DB + 向量）                          │
│  - 衰减召回（清理过期）                              │
│  - 检索（只筛选，不加工）                            │
└─────────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────┐
│                 数据层                               │
│  SQLite3 + sqlite-vec（向量）                        │
│  - memories（主表）                                  │
│  - chunks（段落级索引）                             │
│  - memories_vec（向量表）                           │
└─────────────────────────────────────────────────────┘
```

---

## 一、meta.yaml — 项目配置

用户完全自定义的记忆结构定义。

```yaml
name: my-project
version: "1"

# ============================================================
# 索引范围：路径 + 文件名正则（仅限单层，不递归）
# ============================================================
index_scope:
  - path: "demands/"
    pattern: "*.md"
  - path: "issues/"
    pattern: "*.md"
  - path: "principles/"
    pattern: "*.md"
  - path: "logs/"
    pattern: "*.md"
  - path: "tmp/"
    pattern: "*.md"

# ============================================================
# 维度定义
# ============================================================
dimensions:
  # 正规维度：枚举值，用于检索筛选
  normal:
    - name: category
      values: [demand, issue, principle, log, tmp]
    - name: priority
      values: [P0, P1, P2, P3]
    - name: status
      values: [open, in_progress, closed]

  # 退化维度：触发衰减机制
  decay:
    - name: category
      values: [tmp]

# ============================================================
# 衰减机制（多组）
# ============================================================
decay_groups:
  - name: tmp_ttl
    trigger:
      category: tmp
    function: ttl
    params:
      ttl_hours: 24
    apply_fields: [created_at, expires_at]

  - name: stale_issue
    trigger:
      category: issue
      status: closed
    function: stale_after
    params:
      days: 30
    apply_fields: [updated_at]

# ============================================================
# 向量配置
# ============================================================
vector:
  dimensions: 1024        # bge-m3 embedding 维度
  table: memories_vec
  key_column: chunk_id
  embedding_column: embedding

# ============================================================
# chunk 切分配置
# ============================================================
chunk:
  max_tokens: 512        # 每个 chunk 最大 token 数
  overlap: 64             # 相邻 chunk 重叠 token 数
```

---

## 二、meta.md — 记忆类型文档

用户维护，每个 `index_scope` 条目对应的记忆类型说明。

```markdown
# 项目记忆类型说明

## demands/*.md
**含义**：需求记录
**作用**：追踪用户需求和功能请求
**维度设置**：
  - category: demand（固定）
  - priority: P0-P3（用户指定）
  - status: open/in_progress/closed
**更新方式**：
  - 新增：`skill.create("demand", content)`
  - 状态变更：`skill.update(id, status="closed")`

## issues/*.md
**含义**：问题记录
**作用**：追踪 Bug、技术债务、风险
**维度设置**：
  - category: issue（固定）
  - type: bug/risk/debt（用户指定）
  - priority: P0-P3
**更新方式**：由 Tester 或 Reviewer 维护

## tmp/*.md
**含义**：临时笔记
**作用**：短期约束、一次性备注
**维度设置**：
  - category: tmp（固定）
  - 24h 后自动衰减删除
**更新方式**：`skill.create("tmp", content)`（不写入 DB 向量索引）
```

---

## 三、数据库设计

### 3.1 表结构

```sql
-- 主表（文件级元数据）
CREATE TABLE memories (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,          -- 正规维度
    priority    TEXT,
    status      TEXT,
    type        TEXT,                  -- 自由维度（issue.type 等）
    file_path   TEXT NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    expires_at  TEXT,                 -- 衰减字段（TTL 计算得出）
    deprecated  INTEGER DEFAULT 0      -- 软删除标记
);

-- chunk 表（段落级索引）
CREATE TABLE chunks (
    chunk_id    TEXT PRIMARY KEY,      -- "project::demands/feature-A.md::0" or "global::~/notes.md::0"
    parent_id   TEXT NOT NULL,        -- 溯源到 memories.id
    chunk_index INTEGER,              -- chunk 在文件内的序号
    content     TEXT NOT NULL,        -- 原始文本（用于展示和重嵌入）
    embedding   BLOB,                 -- 向量（写入时生成）
    created_at  TEXT,
    updated_at  TEXT,
    deprecated  INTEGER DEFAULT 0,    -- 软删除标记
    FOREIGN KEY (parent_id) REFERENCES memories(id)
);

-- 向量虚拟表
CREATE VIRTUAL TABLE memories_vec USING vec0(
    chunk_id    TEXT,
    embedding   FLOAT[1024]
);

-- indexes
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_expires_at ON memories(expires_at);
CREATE INDEX idx_chunks_parent ON chunks(parent_id);
CREATE INDEX idx_chunks_deprecated ON chunks(deprecated);
```

### 3.2 向量表联接

```sql
-- 检索时通过 chunk_id JOIN 主表获取文件级维度
SELECT
    m.*,
    c.content,
    c.chunk_id,
    vector_distance_cosine(mv.embedding, ?) AS score
FROM memories_vec mv
JOIN chunks c ON c.chunk_id = mv.chunk_id
JOIN memories m ON m.id = c.parent_id
WHERE m.category = 'demand'
ORDER BY score
LIMIT 20;
```

---

## 四、衰减机制

### 4.1 衰减绑定在索引阶段

```
remx index <file>
  │
  ├─ 解析 meta.yaml，找到文件对应的 index_scope
  ├─ 根据 scope 的 category 查找 decay_groups
  ├─ 如果命中 trigger，计算 expires_at
  │     ttl:      expires_at = now + ttl_hours
  │     stale_after: expires_at = updated_at + days
  ├─ 写入 memories 表（含 expires_at）
  └─ 写入 chunks 表（含向量）
```

**关键**：expire 只写在主表，chunks 通过 parent_id 继承。

### 4.2 gc 召回清理

```
remx gc [--scope <path>]
  │
  ├─ 扫描 index_scope 范围（或指定 scope）
  ├─ 查询 memories WHERE expires_at < now AND deprecated = 0
  ├─ 对每条记录：
  │     - 标记 memories.deprecated = 1
  │     - 标记 chunks.deprecated = 1（通过 parent_id）
  │     - 从 memories_vec 删除（通过 chunk_id）
  ├─ 物理删除已标记的记录（可选，取决于 GC 策略）
  └─ 返回清理报告
```

### 4.3 retrieve 不触发衰减

retrieve 是只读操作，只做 filter 筛选，不过 LLM，不计算。衰减只在 index（写入时）和 gc（清理时）触发。

---

## 五、GC 策略（物理删除）

### 5.1 Skill 层提醒机制

Skill 在用户每次调用 pm 命令时顺便检查，达到阈值后在输出末尾附加安静提示：

| 条件 | 阈值 | 提醒 |
|------|------|------|
| `deprecated` 占比 | > 20% | "N 条过期记录，建议 remx gc" |
| `deprecated` 总数 | > 1000 | "堆积较多，建议 gc" |
| DB 文件大小 | > 50MB | "数据库较大，建议 gc + vacuum" |

**用户操作流程：**

```
用户运行 pm 命令
  → Skill 异步检查（不阻塞）
  → 达到阈值 → 在命令输出末尾附加提醒
  → 用户决定是否运行 remx gc
```

### 5.2 remx gc 命令

```bash
remx gc              # 软删除：标记 deprecated=1
remx gc --purge     # 物理删除：删除 deprecated 记录 + VACUUM
remx gc --dry-run   # 预览，不实际删除
```

### 5.3 原子写入策略

### 5.1 方案A — SQLite 原生事务（已验证）

`remx index <path>` 将三次写入（memories → chunks → memories_vec）包在同一个事务内：

```python
with db.transaction():
    db.execute("INSERT INTO memories ...")
    db.execute("INSERT INTO chunks ...")
    db.execute("INSERT INTO memories_vec (chunk_id, embedding) VALUES (?, ?)", (chunk_id, vec_bytes))
```

**实测结论（2026-04-01）：**
- sqlite-vec 虚拟表正常参与 SQLite 事务，ROLLBACK 有效
- chunks 主键冲突时，三表全部回滚（memories/chunks/vec 均为 0）
- WAL 模式下事务行为正确

### 5.2 方案C — 幂等补偿（备选）

`chunk_id = hash(file_path + para_indices)` 作为确定性 ID，重复执行效果相同：

```sql
DELETE FROM memories_vec WHERE chunk_id = ?;
INSERT INTO memories_vec (chunk_id, embedding) VALUES (?, ?);
```

适合崩溃后重新执行 `remx index` 的恢复场景。

**采用策略：** 初期用方案 A（事务），配合方案 C 的幂等 ID 作为兜底。

---

## 六、chunk 切割算法

### 6.1 双策略：段落优先 / 标题级

```
meta.yaml 配置：
chunk:
  strategy: heading    # "heading" | "paragraph"
  max_tokens: 512
  overlap: 2           # 段落数（非 token）
  heading_levels: [1, 2, 3]   # H1/H2/H3 作为语义单元
```

**strategy=heading（默认）：按 Markdown 标题层级切分**

每个 H1/H2/H3 标题作为一个独立语义单元：
```
# 第一章         ← chunk 边界
内容...

## 1.1 节      ← chunk 边界
内容...

### 1.1.1 小节  ← chunk 边界
内容...
```

算法：
1. 解析 Markdown，识别 `^#{1,3}\s` 标题行
2. 每个标题 + 其后续内容 = 一个语义单元
3. 若单元 token 超过 max_tokens，在该单元内按句子断句（。？！；\n）
4. 无标题的文件 → 回退到 paragraph 策略

**strategy=paragraph：段落级切分（兼容旧逻辑）**

```
1. 按 \n\n 切出所有段落
2. 从第一个段落开始，逐段落累计 token 数
3. 当累计 >= max_tokens，开始下一个 chunk
4. 新 chunk 头部包含前 overlap_paras 个完整段落
5. 单段落超过 max_tokens → 按句子断句
```

### 6.2 overlap 语义定义

overlap 以**段落数**为单位，而非 token 数：
- `overlap: 2` 表示每个新 chunk 头部包含前 2 个完整段落
- overlap 始终卡在段落边界，不在句子中间切开

### 6.3 超长语义单元兜底

当单个标题单元 token 数超过 max_tokens 时，按句子断句：
```
断句符：。？！；\n
取完整句子，直到累计 >= max_tokens
剩余内容从下一 chunk 重新开始
```

### 6.4 代码块和表格保护

```yaml
chunk:
  preserve:
    - code_blocks   # ``` ``` 内的内容不切开
    - tables        # Markdown 表格不切开
```

识别方式：
- 代码块：正则 `` ``` `` 检测，进入代码块模式直到下一个 `` ``` ``
- 表格：识别 `|` 分隔行，整表作为整体

### 6.5 chunk_id 格式

```
project::{relative_path}::{chunk_index}   -- 项目记忆（相对路径）
global::{display_path}::{chunk_index}    -- 全局记忆（~/ 或绝对路径）

示例：
  project::demands/feature-A.md::0       -- 项目内文件
  global::~/notes/idea.md::0             -- 全局记忆（~ 展开）
  global::/tmp/export.md::0              -- 全局记忆（绝对路径）
```

**路径前缀约定：**
- `~` 或 `/` 开头 → global 记忆
- 其他（相对路径）→ project 记忆

**安全：路径含 `..` → 拒绝索引**（防止目录遍历）

### 6.6 Chunk 数据结构

```python
@dataclass
class Chunk:
    chunk_id: str
    content: str           # 实际文本内容
    heading_level: int    # 0=无标题, 1=H1, 2=H2, 3=H3
    heading_text: str     # 标题文本（无标题则空字符串）
    para_indices: list[int]  # 覆盖的段落索引
    token_count: int
```

### 6.7 更新时的 re-chunk

```
skill.update(id, new_content)
  │
  ├─ 读取旧 chunks（deprecated = 0）
  ├─ 重新 split_file(new_content)
  ├─ 旧 chunks → deprecated = 1
  ├─ 新 chunks → 新增记录
  └─ 重建向量（调用 embedding API）
```

---

## 七、CLI 命令集

| 命令 | 职责 | 调用方 |
|------|------|--------|
| `remx parse < meta.yaml` | 验证 meta.yaml 合法性，输出结构化 JSON | Skill |
| `remx init [--reset]` | 解析 meta.yaml，创建/重建所有表和向量索引 | Skill |
| `remx index <path>` | 索引单个文件（触发衰减计算） | Skill |
| `remx index --bulk <path>` | 批量索引目录下所有匹配文件 | Skill |
| `remx gc [--scope <path>]` | 衰减召回清理 | Skill / 定时任务 |
| `remx retrieve --filter <json>` | 检索（只筛选不加工），返回 JSON | Skill |
| `pm chunk_info <path>` | 返回文件的 chunks 列表（不建索引） | Skill |
| `pm file_meta <path>` | 返回文件 header 元数据 | Skill |
| `pm tables` | 列出当前所有表结构 | 用户 |
| `pm validate` | meta.yaml vs DB schema 一致性检查 | 用户 |
| `remx version` | 版本信息 | 用户 |

### retrieve 设计

```bash
remx retrieve --filter '{"category": "demand", "priority": "P1"}'
remx retrieve --filter '{"category": "issue", "status": "open"}'
```

filter 只做字段级等值/范围筛选，CLI 翻译为 SQL WHERE 子句。返回：

```json
[
  {
    "chunk_id": "project::demands/feature-A.md::1",
    "parent_id": "DMD-001",
    "category": "demand",
    "priority": "P1",
    "content": "...",
    "score": 0.87
  }
]
```

Skill 拿到结果后根据 `parent_id` 组装完整上下文。

---

## 八、Skill 层设计

### 7.1 文件管理

```python
class MemoryFileManager:
    def split(self, file_path, meta_yaml) -> List[Chunk]:
        """语义切分文件，返回 chunks"""

    def classify(self, file_path, meta_yaml) -> Optional[IndexScope]:
        """判断文件属于哪个 index_scope"""

    def find_chunks(self, parent_id) -> List[Chunk]:
        """查找某文件的所有 chunks"""

    def partial_update(self, chunk_id, new_content):
        """局部更新 chunk（标记旧 + 新增新）"""

    def create(self, scope, content, meta_yaml) -> str:
        """创建文件 + 切割 + 索引"""
```

### 7.2 操作映射

| 用户意图 | Skill 操作 | CLI 调用 |
|----------|-----------|----------|
| 添加一个 P1 需求 | `create("demand", content, priority=P1)` | `remx index <path>` |
| 查看所有打开的需求 | `retrieve(filter={"category":"demand","status":"open"})` | `remx retrieve --filter ...` |
| 更新第三章内容 | `partial_update(chunk_id, new_content)` | `remx index <path>` |
| 清理过期 tmp | `gc()` | `remx gc` |
| 搜索相关内容 | `semantic_search(query)` | `remx retrieve --filter ...` |

### 7.3 上下文组装

retrieve 返回 chunk 碎片后，Skill 负责：

1. 根据 `parent_id` 找到完整文件所有 chunks
2. 按 `chunk_index` 排序
3. 拼接相邻 chunk（带 overlap）还原完整语义
4. 组装后交给 LLM 处理

---

## 九、与 v1 方案对比

| 项目 | v1（僵化） | v2（范式） |
|------|-------------|-------------|
| 记忆类型 | 硬编码 5 种 | 用户通过 index_scope 定义 |
| category 枚举 | 写死 | meta.yaml 配置 |
| 衰减机制 | 单一 TTL | 多组 decay_groups 可配置 |
| 初始化 | 硬编码建表 | `remx init` 读 meta.yaml |
| CLI 命令 | 11 个 | 8 个 |
| chunk 管理 | 无 | Skill 层完整管理 |
| 向量 schema | 硬编码 | meta.yaml 配置 |
| Skill | 无 | 唯一协调层 |

---

## 十、实施路径

```
Phase 1: CLI 引擎
  - meta.yaml 解析器
  - 表创建/重建（init --reset）
  - index（文件 + chunk + 向量）
  - gc（衰减清理）
  - retrieve（filter 检索）

Phase 2: Skill 协调层
  - ChunkSplitter（语义切分）
  - FileManager（文件 CRUD）
  - ContextAssembler（上下文组装）

Phase 3: 工具链
  - meta.md 生成器（根据 meta.yaml 自动生成模板）
  - validate 命令（配置一致性检查）
  - 向量重建工具（schema 变更后批量重建）

Phase 4: 进阶
  - 多 embedding 模型支持（Ollama bge-m3 / OpenAI / 本地）
  - 增量索引（只索引变更文件）
  - 分布式部署
```
