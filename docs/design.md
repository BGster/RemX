# Project-Manager Skill 设计方案

## 目录结构

```
project-manager/
├── .pm.yaml                       # 配置文件
├── .gitignore                     # 忽略配置
├── memory.db                      # sqlite3 + sqlite-vec 向量数据库
├── share/                         # 项目共享信息（全局共享，全部索引）
│   ├── projects/                  # 项目信息（索引）
│   │   └── PRJ-{name}.md
│   ├── milestones/                # 里程碑记录（索引）
│   │   └── MS-{序号}.md
│   ├── releases/                  # 发布记录（索引）
│   │   └── REL-{版本}.md
│   ├── demands/                   # 官方需求池（索引）— 所有成员共享
│   └── changes/                  # 需求/设计变更（索引）
└── {user}/                        # 用户私有工作区（用户隔离，索引）
    ├── laws/                      # 开发原则（索引）
    ├── daily/                     # 开发日志（索引）
    ├── demands/                   # 个人需求/子任务（索引）— 隔离于官方需求池
    ├── problems/                  # 问题记录（索引）
    ├── decisions/                 # 技术决策 ADR（索引）
    ├── meetings/                  # 会议记录（索引）
    ├── knowledge/                 # 知识库（索引）
    ├── risks/                     # 风险记录（索引）
    ├── references/                # 参考资料链接（索引）
    └── tmp/                       # 临时指令（物理删除，不建索引）
```

---

## 记忆类别

### 官方需求池（share/）

| 类别 | 目录 | 用途 | 索引 | 清理策略 | ID前缀 |
|------|------|------|------|----------|--------|
| 项目信息 | share/projects/ | 项目背景、架构 | 是 | 永久 | PRJ- |
| 里程碑 | share/milestones/ | 关键节点 | 是 | 永久 | MS- |
| 发布记录 | share/releases/ | 版本历史 | 是 | 永久 | REL- |
| 官方需求 | share/demands/ | 需求池，所有成员共享 | 是 | 永久 | DMD- |
| 需求变更 | share/changes/ | 需求/设计变更 | 是 | 永久 | CHG- |

### 用户私有工作区（{user}/）

| 类别 | 目录 | 用途 | 索引 | 清理策略 | ID前缀 |
|------|------|------|------|----------|--------|
| 开发原则 | {user}/laws/ | 必须遵循的规则 | 是 | 永久 | - |
| 开发日志 | {user}/daily/ | 每日工作记录 | 是 | 永久 | - |
| 个人需求 | {user}/demands/ | 个人任务分解、子任务 | 是 | 永久 | DMD- |
| 问题记录 | {user}/problems/ | Bug、技术问题 | 是 | 解决后归档 | PRB- |
| 技术决策 | {user}/decisions/ | ADR 架构决策 | 是 | 永久 | ADR- |
| 会议记录 | {user}/meetings/ | 需求/技术评审 | 是 | 永久 | - |
| 知识库 | {user}/knowledge/ | 业务/技术知识 | 是 | 永久 | - |
| 风险记录 | {user}/risks/ | 风险识别与应对 | 是 | 关闭后归档 | RSK- |
| 参考资料 | {user}/references/ | 链接、文档 | 是 | 永久 | - |
| 临时指令 | {user}/tmp/ | 短期约束 | 否 | **物理删除（不建索引）** | - |

### 核心 5 项能力

为降低复杂度，MVP 阶段聚焦以下核心类型：

| 类别 | 目录 | 用途 | ID前缀 |
|------|------|------|--------|
| 需求记录 | share/demands/ + {user}/demands/ | 需求池 + 个人任务 | DMD- |
| 问题记录 | {user}/problems/ | Bug、技术问题 | PRB- |
| 技术决策 | {user}/decisions/ | ADR 架构决策 | ADR- |
| 开发日志 | {user}/daily/ | 每日工作记录 | - |
| 需求变更 | share/changes/ | 需求/设计变更 | CHG- |

---

## 双线隔离说明

### share/ vs {user}/ 的关系

```
share/demands/  ←→  {user}/demands/
   （官方需求池）      （个人任务区）
        ↑                    ↑
        └── 不打通，隔离管理 ──┘
```

- **share/demands/**：PM 或管理员创建，**所有人可见可认领**，是项目的官方需求来源
- **{user}/demands/**：开发者个人维护，可以是官方需求的子任务分解、个人笔记、想法，**仅自己可见**

两者**不自动同步**，如果需要将个人成果贡献回官方需求池，由 PM 手动录入 `share/demands/`。

### demands、changes、releases 三者定位区分

| 维度 | demands（需求） | changes（变更） | releases（发布） |
|------|----------------|----------------|-----------------|
| 关注点 | 需求内容本身 | 变更控制流程 | 发布结果记录 |
| 时间节点 | 需求提出时 | 变更发生时 | 版本发布时 |
| 核心字段 | 描述、验收标准、技术方案 | 变更原因、影响范围、审批人、回滚方案 | 版本号、发布日期、变更内容 |
| 示例 | "用户需要导出报表功能" | "因合规要求，导出功能需增加水印" | "v1.2.0 发布，新增导出功能" |

**关系链**：demand → change → release（需求经变更后发布）

---

## 技术方案

### 向量检索

- **数据库**: SQLite3
- **向量扩展**: sqlite-vec
- **嵌入模型**: Ollama bge-m3（本地）/ OpenAI API（远程）

### 为什么要向量检索

当前目标是**长期项目维护**，随着项目规模增长：
- 文档数量从几十增长到数百
- 跨项目复用知识的需求出现
- 需要语义搜索而非精确文件名搜索

向量检索可以支持「根据描述找相关需求/问题/决策」的场景，而不只是 `grep` 式的关键词匹配。

### 记忆管理

所有记忆类型统一存储在同一张表中，采用通用表结构设计。

```sql
CREATE TABLE memories (
    id            TEXT PRIMARY KEY,          -- 记忆ID，如 PRB-001, ADR-002
    category      TEXT NOT NULL,             -- 记忆类别
    user_id       TEXT,                      -- 用户ID（share目录下为NULL）
    file_path     TEXT NOT NULL,             -- 文件路径（相对于project-manager/）
    content       TEXT NOT NULL,             -- 内容
    priority      TEXT,                      -- 优先级：P0/P1/P2/P3
    status        TEXT,                      -- 状态：open/in-progress/closed/archived
    extension     TEXT,                      -- 扩展属性（JSON格式，map<string, string>）
    embedding     BLOB,                      -- 向量嵌入（sqlite-vec）
    created_at    TEXT NOT NULL,             -- 创建时间
    updated_at    TEXT NOT NULL,             -- 更新时间
    expires_at    TEXT                       -- 过期时间（仅tmp类别使用，tmp物理删除）
);

-- 索引
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_priority ON memories(priority);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_created_at ON memories(created_at);
```

**extension (扩展属性) 使用示例**：

```json
{
  "tags": "数据库,性能",
  "impact": "高",
  "owner": "zhangsan01",
  "related_demand": "DMD-001"
}
```

**priority 和 status 单独建字段**，支持直接 SQL 过滤和排序；extension 用于存储其他灵活属性。

### tmp/ 特殊处理

- **不建索引**：tmp/ 下的文件不写入 memory.db
- **物理删除**：超过 24h 后直接删除文件，不保留记录
- 适用场景：临时指令、短期约束、一次性备注

---

## 实施步骤

### Step 1: pyproject.toml 依赖配置

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
# 创建 share 子文件夹
(share_dir / "projects").mkdir(parents=True, exist_ok=True)
(share_dir / "milestones").mkdir(parents=True, exist_ok=True)
(share_dir / "releases").mkdir(parents=True, exist_ok=True)
(share_dir / "demands").mkdir(parents=True, exist_ok=True)
(share_dir / "changes").mkdir(parents=True, exist_ok=True)

# 创建用户目录
user_dirs = ["laws", "daily", "demands", "problems", "decisions", "meetings",
              "knowledge", "risks", "references", "tmp"]
```

### Step 3: 文档更新

| 文件 | 更新内容 |
|------|----------|
| `cli/pm/README.md` | 目录结构图、命令说明 |
| `cli/pm/USER_GUIDE.md` | 命令参考 |
| `skills/project-manager/SKILL.md` | 目录结构、索引说明、触发示例 |
| `skills/project-manager/references/document-templates.md` | 模板，添加 ID 前缀 |
| `skills/project-manager/references/cli-reference.md` | 命令参考 |

---

## 验证方法

```bash
# 1. 安装测试
cd cli/pm && uv pip install -e . && pm --version

# 2. 初始化测试
pm init --user test01
# 验证目录结构：
# - share/projects/, share/demands/, share/changes/ 文件夹存在
# - test01/demands/, test01/problems/ 等用户目录存在

# 3. 功能测试
pm log --content "测试日志"
pm demand --title "测试需求" --content "描述内容"
pm problem --content "问题描述" --priority P1

# 4. 边界测试
pm init --user test01 --force  # 覆盖测试
pm tmp --content "临时指令"  # 验证 24h 后物理删除
```
