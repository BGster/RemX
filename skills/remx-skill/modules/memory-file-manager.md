# MemoryFileManager

记忆文件的生命周期管理组件。负责写、更新、删除记忆文件，以及与 `remx index` 的联动。

## 核心职责

- 根据 category 确定文件存放路径
- 写入 / 更新 / 删除 markdown 文件（含 front-matter）
- 触发 `remx index` 将文件编入向量索引
- 触发 `remx gc --purge` 删除已删除文件的索引记录

## 文件路径规范

```
index_scope 内 → 项目记忆
  demands/       → category: demand
  issues/        → category: issue
  principles/    → category: principle
  knowledge/     → category: knowledge
  tmp/           → category: tmp

index_scope 外 → 用户本地文件（RemX 不管理，仅 remx index 可手动索引）
```

## 操作接口

### write(category, front_matter, content, file_path)

**触发场景：** 用户说"记住..."、"记录..."、"这是一个决定..."

**动作流程：**
```
1. 确定文件路径
     - 若传入 file_path → 使用之
     - 若未传入 → 按 category 规则生成路径
       e.g. category=demand → demands/{slugified-title}.md

2. 写入文件
     - 追加 front-matter（YAML 格式）
     - 追加 markdown 内容

3. 调用 remx index
     remx index <file_path> --db <db_path> --meta <meta.yaml>
     → 系统根据 category 决定 decay_group，自动设置 expires_at

4. 返回写入结果
     { file_path, memory_id, chunk_count }
```

**front-matter 模板：**
```yaml
---
category: {category}       # 必填
priority: P1              # 可选
status: open               # 可选（demand/issue 有效）
type: bug                  # 可选
created_at: "{iso8601}"   # 可选，默认当前时间
---
```

### update(file_path, front_matter_diff, content_diff)

**触发场景：** 用户说"更新..."、"修改..."

**动作流程：**
```
1. 读取现有文件内容
2. 合并 front-matter（浅合并，key 相同则覆盖）
3. 合并 content_diff（追加而非覆盖）
4. 写回文件
5. 重新调用 remx index（自动去重）
```

### delete(file_path)

**触发场景：** 用户说"删除..."、"不要这条记忆了"

**动作流程：**
```
1. 删除物理文件
2. 调用 remx gc --purge --scope <file_path>
   → 软删除 + 物理删除该路径下的 index 记录
```

### exists(file_path) → bool

**触发场景：** Skill 内部判断是否需要 create vs update

---

## Category → 路径映射规则

| category | 默认路径 | 说明 |
|----------|----------|------|
| demand | `demands/{slug}.md` | 设计决策、需求 |
| issue | `issues/{slug}.md` | 问题、bug、风险 |
| principle | `principles/{slug}.md` | 原则、规范 |
| knowledge | `knowledge/{slug}.md` | 知识积累 |
| tmp | `tmp/{slug}.md` | 临时笔记（有 TTL）|

路径规则可通过 meta.yaml 的 `index_scope` 自定义。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 文件路径含 `..` | 拒绝（安全） |
| 目标目录不存在 | 自动创建父目录 |
| remx index 失败 | 警告用户，文件已写入但未索引 |
| 文件已存在（write） | 追加模式，不覆盖 |
| 文件不存在（update） | 返回错误，提示先用 write |