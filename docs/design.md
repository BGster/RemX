# RemX

项目记忆与知识管理工具，支持向量检索、用户隔离、长期维护。

## 目录结构

```
remx/
├── .pm.yaml              # 配置文件
├── .gitignore
├── memory.db             # SQLite + sqlite-vec 向量数据库
├── share/                # 项目共享（全局可见）
│   ├── projects/         # 项目信息
│   ├── milestones/       # 里程碑（含版本发布）
│   ├── meetings/         # 会议记录
│   ├── issues/           # 问题 + 风险
│   └── knowledge/        # 知识库 + 参考资料
└── {user}/               # 用户私有工作区
    ├── principles/       # 开发原则 + 技术决策
    ├── daily/            # 开发日志
    ├── demands/          # 个人需求 / 子任务
    └── tmp/              # 临时指令（24h 物理删除，不建索引）
```

## 记忆类别

### share/（项目共享）

| 目录 | 用途 | ID前缀 |
|------|------|--------|
| projects/ | 项目背景、架构 | PRJ- |
| milestones/ | 里程碑节点（含版本发布） | MS- |
| meetings/ | 会议记录 | - |
| issues/ | 问题 + 风险 | ISC- |
| knowledge/ | 知识库 + 参考资料 | - |

### {user}/（用户私有）

| 目录 | 用途 | ID前缀 |
|------|------|--------|
| principles/ | 开发原则 + ADR 技术决策 | - |
| daily/ | 每日工作记录 | - |
| demands/ | 个人任务分解、子任务 | DMD- |
| tmp/ | 临时指令（不建索引） | - |

## 核心能力（5 项）

| 能力 | 目录 | 用途 |
|------|------|--------|
| 需求 | {user}/demands/ | 个人任务 |
| 问题 | share/issues/ | Bug、问题、风险追踪 |
| 原则 | {user}/principles/ | 规则 + ADR 决策 |
| 日志 | {user}/daily/ | 每日工作记录 |
| 知识 | share/knowledge/ | 知识库 + 会议记录 |

## 数据库设计

```sql
CREATE TABLE memories (
    id         TEXT PRIMARY KEY,    -- 记忆ID，如 ISC-001, DMD-001
    category   TEXT NOT NULL,       -- 记忆类别
    user_id    TEXT,                -- 用户ID（share 目录下为 NULL）
    file_path  TEXT NOT NULL,       -- 文件路径
    content    TEXT NOT NULL,       -- 内容
    priority   TEXT,                 -- P0/P1/P2/P3
    status     TEXT,                -- open/in-progress/closed/archived
    extension  TEXT,                -- JSON 扩展属性
    embedding  BLOB,                 -- 向量嵌入
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT                  -- 仅 tmp 使用
);

CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_priority ON memories(priority);
CREATE INDEX idx_memories_status ON memories(status);
```

## 技术选型

- **数据库**：SQLite3 + sqlite-vec
- **向量模型**：Ollama bge-m3（本地）/ OpenAI API（远程）
- **CLI**：Python + Typer + Rich
- **tmp/ 处理**：物理删除，不写入 memory.db

## 实施步骤

### Step 1: pyproject.toml

```toml
dependencies = [
    "typer>=0.12.0",
    "rich>=13.7.0",
    "pydantic>=2.0.0",
    "python-dateutil>=2.8.0",
    "pyyaml>=6.0",
    "sqlite-vec>=0.1.0",
]
```

### Step 2: init.py 目录结构

```python
# share/
(share_dir / "projects").mkdir(parents=True, exist_ok=True)
(share_dir / "milestones").mkdir(parents=True, exist_ok=True)
(share_dir / "meetings").mkdir(parents=True, exist_ok=True)
(share_dir / "issues").mkdir(parents=True, exist_ok=True)
(share_dir / "knowledge").mkdir(parents=True, exist_ok=True)

# {user}/
user_dirs = ["principles", "daily", "demands", "tmp"]
```

## 验证

```bash
# 安装测试
cd cli/pm && uv pip install -e . && pm --version

# 初始化
pm init --user test01

# 功能测试
pm log --content "测试日志"
pm demand --content "测试需求"
pm issue --content "问题描述" --priority P1
```
