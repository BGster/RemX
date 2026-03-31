# Project-Manager Skill 设计方案

## 目录结构

```
project-manager/
├── .pm.yaml                       # 配置文件
├── .gitignore                     # 忽略配置
├── memory.db                      # sqlite3 + sqlite-vec 向量数据库
├── base/                          # 项目基本信息（全局共享，全部索引）
│   ├── projects/                  # 项目信息（索引）
│   │   └── PRJ-{name}.md
│   ├── milestones/                # 里程碑记录（索引）
│   │   └── MS-{序号}.md
│   └── releases/                  # 发布记录（索引）
│       └── REL-{版本}.md
└── {misID}/                       # 用户隔离目录
    ├── laws/                      # 开发原则（索引）
    ├── daily/                     # 开发日志（索引）
    ├── demands/                   # 需求记录（索引）
    ├── problems/                  # 问题记录（索引）
    ├── decisions/                 # 技术决策 ADR（索引）
    ├── meetings/                  # 会议记录（索引）
    ├── knowledge/                 # 知识库（索引）
    ├── changes/                   # 变更记录（索引）
    ├── risks/                     # 风险记录（索引）
    ├── references/                # 参考资料链接（索引）
    └── tmp/                       # 临时指令（索引，24h自动清理）
```

---

## 记忆类别

| 类别 | 目录 | 用途 | 索引 | 清理策略 | ID前缀 |
|------|------|------|------|----------|--------|
| 项目信息 | base/projects/ | 项目背景、架构 | 是 | 永久 | PRJ- |
| 里程碑 | base/milestones/ | 关键节点 | 是 | 永久 | MS- |
| 发布记录 | base/releases/ | 版本历史 | 是 | 永久 | REL- |
| 开发原则 | {misID}/laws/ | 必须遵循的规则 | 是 | 永久 | - |
| 开发日志 | {misID}/daily/ | 每日工作记录 | 是 | 永久 | - |
| 需求记录 | {misID}/demands/ | 需求管理 | 是 | 永久 | DMD- |
| 问题记录 | {misID}/problems/ | Bug、技术问题 | 是 | 解决后归档 | PRB- |
| 技术决策 | {misID}/decisions/ | ADR 架构决策 | 是 | 永久 | ADR- |
| 会议记录 | {misID}/meetings/ | 需求/技术评审 | 是 | 永久 | - |
| 知识库 | {misID}/knowledge/ | 业务/技术知识 | 是 | 永久 | - |
| 变更记录 | {misID}/changes/ | 需求/设计变更 | 是 | 永久 | CHG- |
| 风险记录 | {misID}/risks/ | 风险识别与应对 | 是 | 关闭后归档 | RSK- |
| 参考资料 | {misID}/references/ | 链接、文档 | 是 | 永久 | - |
| 临时指令 | {misID}/tmp/ | 短期约束 | 是 | 24h自动清理 | - |

### 类别区分说明

**demands、changes、releases 三者定位区分**：

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

### 记忆管理

所有记忆类型统一存储在同一张表中，采用通用表结构设计。

```sql
CREATE TABLE memories (
    id            TEXT PRIMARY KEY,          -- 记忆ID，如 PRB-001, ADR-002
    category      TEXT NOT NULL,             -- 记忆类别: project/milestone/release/law/daily/demand/problem/decision/meeting/knowledge/change/risk/reference/tmp
    mis_id        TEXT,                      -- 用户MIS号（base目录下为NULL）
    file_path     TEXT NOT NULL,             -- 文件路径（相对于project-manager/）
    title         TEXT,                      -- 标题
    content       TEXT NOT NULL,             -- 内容
    embedding     BLOB,                      -- 向量嵌入（sqlite-vec）
    attrs         TEXT,                      -- 扩展属性（JSON格式，map<string, string>）
    created_at    TEXT NOT NULL,             -- 创建时间
    updated_at    TEXT NOT NULL,             -- 更新时间
    expires_at    TEXT                       -- 过期时间（仅tmp类别使用）
);

-- 索引
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_mis_id ON memories(mis_id);
CREATE INDEX idx_memories_created_at ON memories(created_at);
```

**扩展属性 (attrs) 使用示例**：

```json
{
  "priority": "P1",
  "status": "open",
  "tags": "数据库,性能",
  "impact": "高",
  "owner": "zhangsan01"
}
```

### 目录结构说明

1. **base/** 目录采用文件夹结构，支持多项目、多里程碑、多版本发布管理
2. **{misID}/** 目录实现用户隔离，每个用户独立管理自己的记忆
3. **索引策略**: 所有目录下的文件内容均建立向量索引，支持语义检索

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
# 创建 base 子文件夹
(base_dir / "projects").mkdir(parents=True, exist_ok=True)
(base_dir / "milestones").mkdir(parents=True, exist_ok=True)
(base_dir / "releases").mkdir(parents=True, exist_ok=True)

# 创建用户目录
subdirs = ["laws", "daily", "demands", "problems", "decisions", "meetings",
           "knowledge", "changes", "risks", "references", "tmp"]
```

### Step 3: 文档更新

| 文件 | 更新内容 |
|------|----------|
| `cli/pm/README.md` | 目录结构图、命令说明 |
| `cli/pm/USER_GUIDE.md` | 命令参考 |
| `skills/project-manager/SKILL.md` | 目录结构、索引说明、触发示例 |
| `skills/project-manager/references/document-templates.md` | 模板，添加 DMD- 前缀 |
| `skills/project-manager/references/cli-reference.md` | 命令参考 |

---

## 验证方法

```bash
# 1. 安装测试
cd cli/pm && uv pip install -e . && pm --version

# 2. 初始化测试
pm init --mis test01
# 验证目录结构：
# - base/projects/, base/milestones/, base/releases/ 文件夹存在
# - demands/ 文件夹存在

# 3. 功能测试
pm log --content "测试日志"
pm problem --title "测试问题" --description "描述"

# 4. 边界测试
pm init --mis test01 --force  # 覆盖测试
```
