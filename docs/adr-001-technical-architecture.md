# ADR-001: RemX 技术架构文档

**状态:** 已接受  
**日期:** 2026-03-31  
**架构师:** Architect Subagent  

---

## 背景

`impl` 分支已完成 CLI 骨架（Typer + Rich），但缺少以下核心实现：
- SQLite + sqlite-vec 向量数据库
- 文件持久化存储
- 向量嵌入生成
- tmp/ 24h TTL 机制

本文档定义完整的技术架构，作为实现指南。

---

## 1. 数据库设计

### 1.1 数据库文件

- **路径:** `{project_root}/memory.db`
- **加载方式:** sqlite-vec 作为 SQLite 扩展加载（`vec0` 虚拟表）

### 1.2 Schema

```sql
-- 记忆主表
CREATE TABLE memories (
    id          TEXT PRIMARY KEY,     -- 记忆唯一ID，如 ISC-001, DMD-001, PRJ-001
    category    TEXT NOT NULL,        -- 记忆类别（见下表）
    user_id     TEXT,                 -- 用户ID，share 目录下为 NULL
    title       TEXT NOT NULL,        -- 简短标题（从首行提取或用户输入）
    content     TEXT NOT NULL,        -- 完整内容
    priority    TEXT,                 -- P0/P1/P2/P3
    status      TEXT DEFAULT 'open',  -- open/in-progress/closed/archived
    tags        TEXT,                 -- JSON 数组字符串，如 '["bug","backend"]'
    extension   TEXT,                 -- JSON 扩展属性（灵活字段）
    file_path   TEXT NOT NULL,        -- 对应文件路径（相对 project_root）
    created_at  TEXT NOT NULL,        -- ISO8601
    updated_at  TEXT NOT NULL,        -- ISO8601
    expires_at  TEXT                  -- TTL 过期时间（仅 tmp 类别使用，ISO8601）
);

-- 索引
CREATE INDEX idx_memories_category   ON memories(category);
CREATE INDEX idx_memories_user_id    ON memories(user_id);
CREATE INDEX idx_memories_priority   ON memories(priority);
CREATE INDEX idx_memories_status     ON memories(status);
CREATE INDEX idx_memories_expires_at ON memories(expires_at);
```

### 1.3 Category 枚举

| Category | 目录 | ID前缀 | User_ID |
|----------|------|--------|---------|
| `project` | share/projects/ | PRJ- | NULL |
| `milestone` | share/milestones/ | MS- | NULL |
| `meeting` | share/meetings/ | MTG- | NULL |
| `issue` | share/issues/ | ISC- | NULL |
| `knowledge` | share/knowledge/ | KNW- | NULL |
| `principle` | {user}/principles/ | PRN- | 有 |
| `daily` | {user}/daily/ | DLY- | 有 |
| `demand` | {user}/demands/ | DMD- | 有 |
| `tmp` | {user}/tmp/ | TMP- | 有 |

### 1.4 sqlite-vec 向量表

```sql
-- 加载 vec 扩展（必须在 openedb 后立即执行）
-- PRAGMA vec_setup = 1;  -- sqlite-vec 0.1.x 用法

CREATE VIRTUAL TABLE memories_vec USING vec0(
    memory_id   TEXT,       -- 关联 memories.id
    embedding   FLOAT[1024] -- bge-m3 embedding dimension: 1024
);

-- 检索示例（Top-K）
SELECT m.*, vector_distance_cosine(mv.embedding, :query_emb) AS score
FROM memories_vec mv
JOIN memories m ON m.id = mv.memory_id
WHERE m.category NOT IN ('tmp')
ORDER BY score ASC
LIMIT :k;
```

> **注意:** `memories_vec` 表结构由 sqlite-vec 0.1.x 定义，`embedding` 维度取决于模型。bge-m3 输出 1024 维。

---

## 2. 嵌入模型集成

### 2.1 配置优先级

`.pm.yaml` 中 `embedder` 字段决定使用哪个 provider：

```yaml
# .pm.yaml
embedder:
  provider: "ollama"   # 或 "openai"
  model: "bge-m3"
  dimension: 1024
  ollama:
    base_url: "http://localhost:11434"
    timeout: 60
  openai:
    api_key: "${OPENAI_API_KEY}"
    model: "text-embedding-3-small"
    dimension: 1536
```

### 2.2 Ollama bge-m3

**优势:** 本地运行，无 API 费用，隐私友好。

```python
# pm/embedding.py
import httpx
from typing import List

class OllamaEmbedder:
    def __init__(self, base_url: str = "http://localhost:11434", model: str = "bge-m3"):
        self.base_url = base_url
        self.model = model

    def embed(self, texts: List[str]) -> List[List[float]]:
        """调用 Ollama /api/embeddings 接口批量生成向量"""
        embeddings = []
        with httpx.Client(timeout=60) as client:
            for text in texts:
                resp = client.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": self.model, "prompt": text}
                )
                resp.raise_for_status()
                embeddings.append(resp.json()["embedding"])
        return embeddings
```

**Ollama 启动:** `ollama run bge-m3`

### 2.3 OpenAI API

**适用场景:** 无本地 Ollama 环境。

```python
# pm/embedding.py
from openai import OpenAI
from typing import List

class OpenAIEmbedder:
    def __init__(self, api_key: str, model: str = "text-embedding-3-small", dimension: int = 1536):
        self.client = OpenAI(api_key=api_key)
        self.model = model
        self.dimension = dimension

    def embed(self, texts: List[str]) -> List[List[float]]:
        response = self.client.embeddings.create(
            model=self.model,
            input=texts  # 批量，最大 2048 条/请求
        )
        return [item.embedding for item in response.data]
```

### 2.4 Embedding Pipeline

```
用户输入 content
    → 预处理（分块、清洗）
    → 调用 embedder.embed([chunk])
    → 获得 float[1024] 向量
    → 写入 memories_vec 表
    → 同时写入 memories 表（文件）
```

**分块策略:**  
- 单条 memory 内容 < 512 tokens：整条做 embedding  
- > 512 tokens：按段落分块，每块独立向量，parent_id 关联

---

## 3. 文件存储方案

### 3.1 .pm.yaml 配置格式

```yaml
# .pm.yaml（项目根目录下）
version: "1.0"

project:
  name: "my-project"
  root: "."  # 项目根目录，memory.db 和 .pm.yaml 所在目录

embedder:
  provider: "ollama"      # "ollama" | "openai"
  model: "bge-m3"
  dimension: 1024
  ollama:
    base_url: "http://localhost:11434"
    timeout: 60
  openai:
    api_key: "${OPENAI_API_KEY}"
    model: "text-embedding-3-small"

tmp:
  ttl_hours: 24           # tmp 目录文件自动过期时间
  gc_interval_minutes: 60 # 后台 GC 扫描间隔

user:
  id: "zeki"              # 当前用户 ID
  workspace: "zeki/"      # 用户私有工作区目录
```

### 3.2 记忆文件命名规则

| Category | 命名格式 | 示例 |
|----------|---------|------|
| project | `PRJ-{序号}-{slug}.md` | `PRJ-001-backend-api.md` |
| milestone | `MS-{序号}-{slug}.md` | `MS-001-v2.0-release.md` |
| meeting | `{date}-{slug}.md` | `2026-03-31-planning.md` |
| issue | `ISC-{序号}-{slug}.md` | `ISC-001-login-bug.md` |
| knowledge | `{date}-{slug}.md` | `2026-03-31-api-design.md` |
| principle | `{date}-{slug}.md` | `2026-03-31-test-first.md` |
| daily | `{date}.md` | `2026-03-31.md` |
| demand | `DMD-{序号}-{slug}.md` | `DMD-001-user-auth.md` |
| tmp | `{date}-{uuid-short}.md` | `2026-03-31-a3f5c.md` |

**ID 序号生成:** 从 `memories` 表查询 `category = X` 的最大序号 +1，Padded 到 3 位（可扩展）。

### 3.3 文件 Front-matter 格式

```markdown
---
id: ISC-001
category: issue
user_id: null
title: 登录接口偶发性 500 错误
priority: P1
status: open
tags: ["bug", "backend", "auth"]
created_at: 2026-03-31T14:00:00+08:00
updated_at: 2026-03-31T14:00:00+08:00
expires_at: null
---

# 登录接口偶发性 500 错误

## 描述
...

## 复现步骤
...

## 根因分析
...
```

### 3.4 目录结构

```
{project_root}/
├── .pm.yaml
├── memory.db
├── share/                        # user_id = NULL
│   ├── projects/
│   ├── milestones/
│   ├── meetings/
│   ├── issues/
│   └── knowledge/
└── {user_id}/                    # user_id 有值
    ├── principles/
    ├── daily/
    ├── demands/
    └── tmp/
```

---

## 4. tmp/ TTL 实现

### 4.1 设计决策：后台进程 + Cron 双保险

**方案 A: 纯 Cron**  
- `crontab`: `0 * * * * pm gc --expired`（每小时运行）
- 缺点: 依赖系统 cron，跨平台麻烦

**方案 B: 纯后台进程（daemon）**  
- `pm daemon` 启动后台 GC 线程
- 缺点: 用户需记得启动 daemon

**方案 C: 后台进程 + 懒检查（本文采用）**  
- **懒检查:** 每次 `pm` 命令执行时，顺带检查 tmp/ 下过期文件（`expires_at < now`）
- **可选 daemon:** `pm daemon` 启动独立 GC 进程，支持小时级精确清理
- **系统 cron（可选）:** 用户可配置 `pm gc --expired` 的 cron 任务作为兜底

**推荐实现:**

```python
# pm/core.py
from datetime import datetime, timedelta, timezone

def gc_expired(project_root: Path):
    """清理 tmp/ 下已过期的文件和对应 DB 记录"""
    now = datetime.now(timezone.utc)
    conn = connect_db(project_root / "memory.db")
    rows = conn.execute(
        "SELECT id, file_path FROM memories WHERE category='tmp' AND expires_at < ?",
        (now.isoformat(),)
    ).fetchall()
    for row in rows:
        fpath = project_root / row["file_path"]
        if fpath.exists():
            fpath.unlink()
        conn.execute("DELETE FROM memories WHERE id = ?", (row["id"],))
        conn.execute("DELETE FROM memories_vec WHERE memory_id = ?", (row["id"],))
    conn.commit()

def lazy_gc(project_root: Path, probability: float = 0.1):
    """以概率触发懒 GC，避免每次命令都扫描（10% 概率）"""
    import random
    if random.random() < probability:
        gc_expired(project_root)
```

### 4.2 expires_at 设置规则

```python
def set_tmp_expiry() -> str:
    ttl = load_config().tmp.ttl_hours  # 默认 24
    expires = datetime.now(timezone.utc) + timedelta(hours=ttl)
    return expires.isoformat()
```

---

## 5. CLI 命令实现方案

### 5.1 命令列表

| 命令 | 说明 | 对应 Category |
|------|------|--------------|
| `pm init [--user ID]` | 初始化项目/用户工作区 | - |
| `pm log [--content TEXT] [--file FILE]` | 写每日日志 | daily |
| `pm demand [--content TEXT] [--priority P0-P3]` | 创建需求/任务 | demand |
| `pm issue [--content TEXT] [--priority P0-P3]` | 创建问题/风险 | issue |
| `pm principle [--content TEXT]` | 添加开发原则 | principle |
| `pm knowledge [--content TEXT]` | 添加知识/文档 | knowledge |
| `pm project [--content TEXT]` | 添加项目信息 | project |
| `pm milestone [--content TEXT]` | 添加里程碑 | milestone |
| `pm meeting [--content TEXT]` | 添加会议记录 | meeting |
| `pm tmp [--content TEXT]` | 添加临时笔记 | tmp |
| `pm list [--category C] [--status S] [--user U]` | 列出记忆 | - |
| `pm search [--query TEXT] [--top-k K]` | 向量语义搜索 | - |
| `pm get <id>` | 查看单条记忆 | - |
| `pm update <id> [--content TEXT] [--status S]` | 更新记忆 | - |
| `pm delete <id>` | 删除记忆 | - |
| `pm gc [--expired]` | 垃圾回收（清理 tmp 过期） | - |
| `pm daemon` | 启动后台 GC 守护进程 | - |
| `pm version` | 显示版本 | - |

### 5.2 核心模块结构

```
pm/
├── __init__.py          # Typer app 入口，版本信息
├── config.py            # .pm.yaml 加载解析（Pydantic model）
├── db.py                # SQLite 连接、vec 扩展加载、CRUD
├── embedding.py         # Ollama/OpenAI embedder 封装
├── storage.py           # 文件读写、Front-matter 解析/写入
├── idgen.py             # ID 序号生成器
├── gc.py                # tmp TTL 清理逻辑
├── daemon.py            # 后台 GC 进程
└── commands/            # 命令模块化
    ├── __init__.py
    ├── init.py          # pm init
    ├── add.py           # pm log/demand/issue/knowledge...（通用 add 逻辑）
    ├── list.py          # pm list
    ├── search.py        # pm search
    ├── get.py           # pm get
    ├── update.py        # pm update
    ├── delete.py        # pm delete
    └── gc.py            # pm gc
```

### 5.3 Add 命令实现逻辑

```python
# pm/commands/add.py
from pathlib import Path
from datetime import datetime, timezone
import uuid

def add_memory(category: str, content: str, user_id: str | None, priority: str = None, **kwargs):
    # 1. 解析 content（支持 --content TEXT 或从 stdin/file）
    # 2. 生成 ID（IDGen）
    # 3. 确定文件路径
    file_path = resolve_path(category, user_id, id)
    # 4. 写文件（Front-matter + content）
    write_memory_file(file_path, front_matter, content)
    # 5. 生成 embedding（跳过 tmp）
    if category != "tmp":
        embedding = embedder.embed([content])[0]
    else:
        embedding = None
    # 6. 写入 DB
    db.insert_memory(id, category, user_id, title, content, embedding, ...)
    return id
```

### 5.4 Search 命令实现逻辑

```python
# pm/commands/search.py
def search(query: str, top_k: int = 5, category: str = None, user_id: str = None):
    # 1. 加载配置，确定 embedder
    embedder = load_embedder()
    # 2. query 向量化
    query_emb = embedder.embed([query])[0]
    # 3. 向量检索
    results = db.vector_search(
        query_emb,
        top_k=top_k,
        category=category,
        user_id=user_id,
        exclude_categories=["tmp"]
    )
    # 4. 输出（Rich table）
    console.print_rich_table(results)
```

---

## 6. 关键实现注意事项

### 6.1 sqlite-vec 扩展加载

```python
# pm/db.py
import sqlite3
import sqlite_vec

def get_db(db_path: Path):
    conn = sqlite3.connect(str(db_path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    # sqlite-vec 0.1.x: 创建表
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0()")
    return conn
```

### 6.2 向量搜索 SQL（sqlite-vec）

```sql
SELECT m.*, vector_distance_cosine(mv.embedding, :query_vec) AS score
FROM memories_vec mv
JOIN memories m ON m.id = mv.memory_id
WHERE m.category NOT IN ('tmp')
  AND (:category IS NULL OR m.category = :category)
ORDER BY score ASC
LIMIT :top_k;
```

### 6.3 配置热加载

`.pm.yaml` 在每次命令执行时重新读取（不需要重启 daemon）。

### 6.4 迁移策略

首次 `pm init` 时创建完整目录结构和空 `memory.db`（含 vec 虚拟表）。后续 `pm init --user <id>` 仅创建用户私有目录。

---

## 7. 依赖清单

```toml
[dependencies]
typer = ">=0.12.0"
rich = ">=13.7.0"
pydantic = ">=2.0.0"
python-dateutil = ">=2.8.0"
pyyaml = ">=6.0"
sqlite-vec = ">=0.1.0"
httpx = ">=0.27.0"       # Ollama 调用
openai = ">=1.0.0"       # OpenAI 调用（可选）
```

---

## 8. 未解决问题 & 后续决策

| 问题 | 候选方案 | 推荐 |
|------|---------|------|
| tmp/ 文件名使用 UUID 还是日期？ | UUID-short（唯一性） vs 日期（可读性） | 两者结合：`{date}-{short_uuid}` |
| ID 序号是否跨项目全局？ | 全局（单 DB） vs 项目内 | 项目内（DB 在项目目录下） |
| 向量维度异构（不同 embedder）？ | 固定 model | 在 .pm.yaml 中明确 model，不混用 |
| 多用户并发写入？ | SQLite WAL 模式 | WAL + write-ahead logging |
| Front-matter 用什么解析？ | PyYAML 直接读写 | 自写轻量解析（避免依赖 ruamel.yaml） |
