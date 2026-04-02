# RemX 技术规格文档

> 基于 `docs/design.md` v0.1.0 分析输出
> 分析师：Analyzer | 日期：2026-03-31

---

## 1. CLI 命令完整功能规格

### 1.1 全局参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--config` | Path | `.pm.yaml` | 配置文件路径 |
| `--user` | str | 读取 `.pm.yaml` 或 `whoami` | 当前用户 ID |

### 1.2 命令清单

---

#### `pm init`

**功能：** 初始化项目目录结构，可指定用户。

```bash
pm init --user <username>
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--user` | str | Yes | - | 用户名（将创建 `{user}/` 目录） |
| `--force` | flag | No | False | 强制重新初始化（覆盖已有目录） |

**输出：**
```
[bold]✓[/bold] Initialized project for user: [cyan]zeki[/cyan]
  share/
    projects/
    milestones/
    meetings/
    issues/
    knowledge/
  zeki/
    principles/
    daily/
    demands/
    tmp/
  Config: .pm.yaml
  Database: memory.db
```

**行为：**
1. 若 `.pm.yaml` 不存在，创建配置文件
2. 若 `memory.db` 不存在，初始化 SQLite + sqlite-vec 表结构
3. 创建 `share/` 下的 5 个子目录（始终全局共享）
4. 创建 `{user}/` 下的 4 个子目录
5. 写入 `.pm.yaml`：当前用户、数据库路径、share 根路径

**错误处理：**
- 用户目录已存在且无 `--force`：输出警告并跳过
- 数据库初始化失败：抛出 `DatabaseError`

---

#### `pm log`

**功能：** 在用户私有 `daily/` 下创建一条开发日志。

```bash
pm log --content <text> [--date <YYYY-MM-DD>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 日志正文内容 |
| `--date` | str | No | 今日 | 日期（YYYY-MM-DD），决定写入哪个文件 |

**输出：**
```
[bold]📝 Log added[/bold]
  Date: 2026-03-31
  File: zeki/daily/2026-03-31.md
  Content: "完成模块A开发"
```

**文件路径：** `{user}/daily/{date}.md`

**行为：**
- 文件按日期组织，每日一个文件
- 同一日的多条 log 追加到同一文件
- 写入 `memory.db`，category=`daily`，user_id=`{user}`

**文件模板：**

```markdown
# 开发日志 - 2026-03-31

## 09:00
- 任务：xxx
- 进度：完成模块A

## 14:00
- 任务：xxx
- 进度：修复Bug
```

---

#### `pm demand`

**功能：** 创建个人需求/任务，存入 `{user}/demands/`。

```bash
pm demand --content <text> [--priority <P0|P1|P2|P3>] [--status <status>] [--extension <json>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 需求描述 |
| `--priority` | str | No | P2 | 优先级 |
| `--status` | str | No | open | 状态：open / in_progress / closed / archived |
| `--extension` | str | No | {} | JSON 扩展属性 |
| `--title` | str | No | content 前40字符 | 标题 |

**输出：**
```
[bold]✓ Demand created[/bold]
  ID: DMD-001
  Priority: P1
  Status: open
  File: zeki/demands/DMD-001.md
```

**文件路径：** `{user}/demands/DMD-{序号}.md`

**ID 规则：**
- `DMD-{3位序号}`，如 `DMD-001`
- 序号在 `{user}/demands/` 范围内自增
- share/demands/ 共用同一计数器（通过数据库 `demands` category 的 MAX id + 1）

**文件模板：**

```markdown
# DMD-001: 用户登录功能

- **优先级**: P1
- **状态**: open
- **创建时间**: 2026-03-31 14:00
- **更新时间**: 2026-03-31 14:00

## 描述

实现用户登录功能，包括：
- [ ] 用户名密码校验
- [ ] Token 生成
- [ ] 会话管理

## 扩展属性

```json
{
  "owner": "zeki",
  "estimate": "2d"
}
```

## 关联

- 父需求：
- 子任务：
- 相关问题：ISC-xxx
```

---

#### `pm issue`

**功能：** 创建项目问题/风险，存入 `share/issues/`。

```bash
pm issue --content <text> [--priority <P0|P1|P2|P3>] [--status <status>] [--type <bug|risk|question>] [--extension <json>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 问题描述 |
| `--priority` | str | No | P2 | 优先级 |
| `--status` | str | No | open | 状态：open / in_progress / resolved / closed |
| `--type` | str | No | bug | 类型：bug / risk / question |
| `--extension` | str | No | {} | JSON 扩展属性 |

**输出：**
```
[bold]✓ Issue created[/bold]
  ID: ISC-001
  Type: bug
  Priority: P1
  Status: open
  File: share/issues/ISC-001.md
```

**文件路径：** `share/issues/ISC-{序号}.md`

**文件模板：**

```markdown
# ISC-001: 数据库连接泄漏

- **类型**: bug
- **优先级**: P1
- **状态**: open
- **创建时间**: 2026-03-31 14:00
- **更新时间**: 2026-03-31 14:00

## 问题描述

在高频请求场景下，数据库连接未正确释放，导致连接池耗尽。

## 复现步骤

1. 发送 1000 QPS 请求
2. 观察连接池

## 影响

- 影响模块：支付模块
- 严重程度：高

## 解决方案

（待填写）

## 关联

- 相关需求：DMD-xxx
- 相关知识：
```

---

#### `pm principles`

**功能：** 记录开发原则或 ADR（架构决策记录），存入 `{user}/principles/`。

```bash
pm principles --content <text> [--type <principle|adr>] [--status <active|superseded>] [--extension <json>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 原则/决策内容 |
| `--type` | str | No | principle | 类型：principle / adr |
| `--status` | str | No | active | 状态：active / superseded |
| `--extension` | str | No | {} | JSON 扩展属性 |

**输出：**
```
[bold]✓ Principle recorded[/bold]
  Type: principle
  File: zeki/principles/principle-001.md
```

**文件路径：** `{user}/principles/{type}-{序号}.md`

**文件模板（principle）：**

```markdown
# Principle: 所有 API 必须鉴权

- **类型**: principle
- **状态**: active
- **创建时间**: 2026-03-31 14:00
- **更新时间**: 2026-03-31 14:00

## 规则

所有对外部暴露的 API 接口必须经过身份验证，禁止匿名访问。

## 理由

安全性要求，防止未授权访问。

## 适用范围

所有微服务
```

**文件模板（adr）：**

```markdown
# ADR-001: 采用 JWT 作为 Token 方案

- **类型**: adr
- **状态**: active
- **创建时间**: 2026-03-31 14:00
- **决策者**: zeki

## 背景

需要选择一种 Token 方案来管理用户会话。

## 决策

采用 JWT（JSON Web Token），使用 RS256 签名。

## 后果

- **正面**：无状态、可跨域
- **负面**：Token 撤销困难（需配合黑名单）

## 替代方案

- Session Cookie：被否决（扩展性差）
- OAuth2 Opaque Token：被否决（需要中央验证）
```

---

#### `pm knowledge`

**功能：** 添加知识条目到 `share/knowledge/`。

```bash
pm knowledge --content <text> [--title <title>] [--tags <tag1,tag2>] [--type <note|doc|reference>] [--extension <json>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 知识正文 |
| `--title` | str | No | content 前50字符 | 标题 |
| `--tags` | str | No | [] | 标签列表（逗号分隔） |
| `--type` | str | No | note | 类型：note / doc / reference |

**输出：**
```
[bold]✓ Knowledge added[/bold]
  ID: KNW-001
  Type: note
  Tags: [jwt, auth, security]
  File: share/knowledge/KNW-001.md
```

**文件路径：** `share/knowledge/KNW-{序号}.md`

**文件模板：**

```markdown
# KNW-001: JWT 最佳实践

- **类型**: reference
- **标签**: jwt, auth, security
- **创建时间**: 2026-03-31 14:00
- **更新时间**: 2026-03-31 14:00

## 摘要

JWT（JSON Web Token）是一种开放标准，用于在各方之间安全地传输信息。

## 核心要点

1. **签名算法**：使用 RS256 或 ES256，避免 HS256（对称算法泄露后果严重）
2. **过期时间**：Access Token 建议 15 分钟，Refresh Token 建议 7 天
3. **Claims**：避免在 Token 中存储敏感信息

## 示例代码

```python
import jwt

token = jwt.encode(
    {"sub": "user123", "exp": datetime.utcnow() + timedelta(minutes=15)},
    private_key,
    algorithm="RS256"
)
```

## 参考资料

- https://jwt.io/introduction/
- RFC 7519
```

---

#### `pm tmp`

**功能：** 创建临时笔记，24h 后自动删除，**不写入 memory.db**。

```bash
pm tmp --content <text> [--ttl <hours>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--content` | str | Yes | - | 临时笔记内容 |
| `--ttl` | int | No | 24 | 存活时间（小时） |

**输出：**
```
[bold]✓ Tmp note created[/bold]
  ID: TMP-a1b2c3d4
  Expires: 2026-04-01 14:00 (24h)
  File: zeki/tmp/TMP-a1b2c3d4.md
```

**文件路径：** `{user}/tmp/TMP-{随机ID}.md`

**文件模板：**

```markdown
# Tmp Note - 2026-03-31 14:00

## 内容

周一开会讨论项目进度，记得提前准备 PPT。

## 元信息

- **创建时间**: 2026-03-31 14:00:00
- **过期时间**: 2026-04-01 14:00:00
- **TTL**: 24h
- **ID**: TMP-a1b2c3d4
```

**重要约束：**
- 不写入 `memory.db`（`memory.db` 仅通过向量检索已「正式化」的记忆）
- 不生成 embedding
- 过期后物理删除（文件系统中删除）

---

#### `pm version`

**功能：** 显示版本信息。

```bash
pm version
```

**输出：**
```
[bold green]pm[/bold green] v0.1.0
```

---

#### `pm list`（补充命令，design.md 未列出但应为必需）

**功能：** 列出记忆条目。

```bash
pm list [--category <category>] [--user <username>] [--status <status>] [--limit <n>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--category` | str | No | all | 类别：daily / demand / issue / principles / knowledge / tmp |
| `--user` | str | No | 当前用户 | 用户过滤 |
| `--status` | str | No | all | 状态过滤 |
| `--limit` | int | No | 50 | 返回条数上限 |

---

#### `pm search`（补充命令，向量检索）

**功能：** 语义搜索记忆。

```bash
pm search --query <text> [--category <category>] [--limit <n>]
```

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--query` | str | Yes | - | 搜索 query |
| `--category` | str | No | all | 限定类别 |
| `--limit` | int | No | 10 | 返回条数 |

---

## 2. 目录初始化逻辑

### 2.1 初始化流程图

```
pm init --user <username>
    │
    ├─→ 读取/创建 .pm.yaml
    │       fields: current_user, db_path, share_root
    │
    ├─→ 初始化 memory.db
    │       ├─ CREATE TABLE memories (...)
    │       ├─ CREATE INDEX ...
    │       └─ sqlite-vec 虚拟表初始化
    │
    ├─→ 创建 share/ (全局共享，始终存在)
    │       share/projects/      (PRJ-*.md)
    │       share/milestones/    (MS-*.md)
    │       share/meetings/      (MTG-*.md)
    │       share/issues/        (ISC-*.md)
    │       share/knowledge/     (KNW-*.md)
    │
    └─→ 创建 {user}/ (用户私有)
            {user}/principles/    (principle-*.md, adr-*.md)
            {user}/daily/        (YYYY-MM-DD.md)
            {user}/demands/      (DMD-*.md)
            {user}/tmp/          (TMP-*.md)
```

### 2.2 目录创建规则

| 目录 | 创建条件 | 创建时机 | 可见性 |
|------|----------|----------|--------|
| `share/` | 始终创建 | `pm init` | 全局 |
| `share/projects/` | 始终创建 | `pm init` | 全局 |
| `share/milestones/` | 始终创建 | `pm init` | 全局 |
| `share/meetings/` | 始终创建 | `pm init` | 全局 |
| `share/issues/` | 始终创建 | `pm init` | 全局 |
| `share/knowledge/` | 始终创建 | `pm init` | 全局 |
| `{user}/` | 首次指定该用户时创建 | 每次 `pm init --user X` | 用户私有 |
| `{user}/principles/` | 用户目录创建时创建 | 首次 `pm init --user X` | 用户私有 |
| `{user}/daily/` | 用户目录创建时创建 | 首次 `pm init --user X` | 用户私有 |
| `{user}/demands/` | 用户目录创建时创建 | 首次 `pm init --user X` | 用户私有 |
| `{user}/tmp/` | 用户目录创建时创建 | 首次 `pm init --user X` | 用户私有 |

**注意：** `pm init` 可多次运行，每次传入不同 `--user` 时仅创建该用户的私有目录，不影响 share/ 和其他用户目录。

### 2.3 .pm.yaml 配置格式

```yaml
# .pm.yaml
project_manager:
  version: "0.1.0"
  current_user: zeki
  db_path: memory.db
  share_root: share

users:
  - zeki
  - test01
```

---

## 3. 记忆文件格式规范

### 3.1 通用文件头（所有记忆文件遵循）

```markdown
# {标题}

- **ID**: {ID}          # 不适用于 meetings/daily/principles(tmp)
- **类型**: {type}
- **优先级**: {P0-P3}    # 仅 demand/issue
- **状态**: {status}
- **创建时间**: {YYYY-MM-DD HH:MM}
- **更新时间**: {YYYY-MM-DD HH:MM}
- **用户**: {username}   # 仅 {user}/ 下的文件
```

### 3.2 文件类型总览

| 类型 | 位置 | ID前缀 | 状态流转 | 优先级 |
|------|------|--------|----------|--------|
| project | share/projects/ | PRJ- | - | - |
| milestone | share/milestones/ | MS- | draft → published → archived | - |
| meeting | share/meetings/ | MTG- | - | - |
| issue | share/issues/ | ISC- | open → in_progress → resolved → closed | P0/P1/P2/P3 |
| knowledge | share/knowledge/ | KNW- | - | - |
| demand | {user}/demands/ 或 share/demands/ | DMD- | draft → approved → in_progress → verified → delivered | P0/P1/P2/P3 |
| principle | {user}/principles/ | - | active / superseded | - |
| adr | {user}/principles/ | ADR- | active / superseded | - |
| daily | {user}/daily/ | - | - | - |
| tmp | {user}/tmp/ | TMP- | - (24h TTL) | - |

### 3.3 编号规则

**ID 计数器统一管理（数据库 + 本地计数器文件）：**

- 计数器存储在 `memory.db` 中，通过 `SELECT MAX(id)` 获取最大值后 +1
- `PRJ-`, `MS-`, `ISC-`, `KNW-`, `DMD-`, `ADR-` 均使用全局自增序号
- `MTG-` 使用年月编号：`MTG-202603`
- `TMP-` 使用随机短 ID（8字符）：`TMP-a1b2c3d4`
- `daily` 使用日期：`YYYY-MM-DD.md`
- `principle`/`adr` 在用户范围内自增

### 3.4 状态流转

**demand 状态机：**
```
draft → approved → in_progress → verified → delivered → closed
```

**issue 状态机：**
```
open → in_progress → resolved → closed
open → wonfix → closed (won't fix)
```

**principle/adr 状态机：**
```
active ↔ superseded
```

---

## 4. tmp/ 24h TTL 技术实现方案

### 4.1 设计约束

1. **不写入 memory.db** — tmp 条目不参与向量检索
2. **物理删除** — 过期后直接删除文件，不经过回收站
3. **基于文件系统的过期检测** — 不依赖后台守护进程
4. **惰性清理** — 在任意 pm 命令执行时顺便检查过期文件

### 4.2 过期时间存储

文件元信息头中包含 `expires_at` 字段：

```markdown
- **创建时间**: 2026-03-31 14:00:00
- **过期时间**: 2026-04-01 14:00:00
- **TTL**: 24h
```

文件名不包含过期信息（允许用户重命名）。

### 4.3 清理策略：惰性清理（Lazy Cleanup）

**核心思路：** 不使用 cron/damon，而是在每次 `pm` 命令执行时，插入一个轻量级的清理检查。

**实现位置：** CLI 入口 `@app.callback()` 中集成清理逻辑：

```python
@app.callback()
def main_callback(
    ctx: typer.Context,
    config: str = ".pm.yaml",
):
    # 每次命令执行前清理过期 tmp 文件
    cleanup_tmp_files()
```

```python
def cleanup_tmp_files(user: str) -> None:
    """
    惰性清理：检查用户 tmp/ 目录下所有文件，
    删除其中 expires_at < now 的文件。
    """
    tmp_dir = Path(user) / "tmp"
    if not tmp_dir.exists():
        return

    now = datetime.now()
    for file in tmp_dir.glob("TMP-*.md"):
        try:
            content = file.read_text()
            expires_match = re.search(r"\*\*过期时间\*\*:\s*(.+)", content)
            if expires_match:
                expires_at = parse_datetime(expires_match.group(1))
                if expires_at < now:
                    file.unlink()
                    console.print(f"[dim]🗑 Removed expired tmp: {file.name}[/dim]")
        except Exception:
            # 文件损坏/无法解析时保留，避免误删
            pass
```

### 4.4 创建时的 TTL 写入

```python
def create_tmp_note(content: str, ttl_hours: int = 24) -> Path:
    tmp_id = generate_short_id()  # 8位随机字符
    now = datetime.now()
    expires_at = now + timedelta(hours=ttl_hours)

    file_content = f"""\
# Tmp Note - {now.strftime('%Y-%m-%d %H:%M')}

## 内容

{content}

## 元信息

- **创建时间**: {now.strftime('%Y-%m-%d %H:%M:%S')}
- **过期时间**: {expires_at.strftime('%Y-%m-%d %H:%M:%S')}
- **TTL**: {ttl_hours}h
- **ID**: TMP-{tmp_id}
"""
    file_path = user_dir / "tmp" / f"TMP-{tmp_id}.md"
    file_path.write_text(file_content)
    return file_path
```

### 4.5 备选方案：watchdog 守护进程

若需要更严格的实时清理，可选配守护进程：

```yaml
# .pm.yaml
tmp_cleanup:
  enabled: true
  interval_minutes: 60
  mode: daemon  # 或 "cron"
```

```bash
# 通过 pm cron 命令注册
pm cron register --cleanup-tmp --every 60m
```

**推荐：惰性清理（方案 A）**，原因：
- 无额外进程开销
- 零配置，开箱即用
- 对于 24h TTL，分钟级误差可接受
- 复杂度低，bug 风险小

### 4.6 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| tmp 文件创建后用户修改了 `过期时间` | 以文件内 `过期时间` 为准，不信任修改后的值 |
| tmp 文件创建后被移动 | 检测到原路径不存在时跳过，不报错 |
| tmp 文件被重命名 | 仍可解析内容中的过期时间 |
| 用户离线超过 24h，期间无任何 pm 调用 | 下次调用 pm 时清理，误差最大 = 最后一次调用到过期的距离 |
| memory.db 中是否有 tmp 记录 | **无**，tmp 不进入数据库 |

---

## 附录：数据库表结构

```sql
CREATE TABLE memories (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,        -- daily|demand|issue|principles|knowledge|project|milestone|meeting
    user_id     TEXT,                 -- share 为 NULL，{user}/ 下为用户名
    file_path   TEXT NOT NULL,
    content     TEXT NOT NULL,
    title       TEXT,
    priority    TEXT,                 -- P0|P1|P2|P3
    status      TEXT,                 -- 状态机见各类型定义
    type        TEXT,                 -- bug|risk|question|principle|adr|note|doc|reference
    tags        TEXT,                 -- JSON array
    extension   TEXT,                 -- JSON object
    embedding   BLOB,                 -- 向量嵌入 (sqlite-vec)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    expires_at  TEXT                  -- 仅 tmp 使用
);

CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_priority ON memories(priority);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_expires_at ON memories(expires_at);

-- sqlite-vec 虚拟表
CREATE VIRTUAL TABLE memories_vec USING vec0(
    embedding FLOAT[1024]
);
```

---

*文档版本：v1.0 | 分析师：Analyzer | 状态：完成*
