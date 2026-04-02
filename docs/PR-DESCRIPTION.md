## RemX v0.2.0 — Phase 1 完成

### 主要改动

**CLI 引擎（Phase 1）**
- `remx init` — 数据库和目录结构初始化
- `remx index` — 文件索引，支持 heading/paragraph 两种 chunk 策略
- `remx retrieve` — 向量检索，支持 filter 过滤
- `remx gc` — GC 清理（dry-run / soft-delete / purge）
- `remx parse` — meta.yaml 验证
- `remx version` — 版本号

**Bug 修复**
- `parse -` stdin 读取 bug（exit code 错误）
- `index` 重复索引 FOREIGN KEY 错误（write_memory 删除顺序）
- `chunk_by_headings` 内层变量遮蔽导致重复 chunk_id
- `index_.py` 警告消息 f-string 未插值
- 删除废弃的 `commands/add.py`

**Skill 文档重构**
- `skills/remx-skill/modules/` — 4 个组件文档
  - MemoryFileManager: 文件生命周期管理
  - ChunkSplitter: heading 结构验证
  - ContextAssembler: 检索结果组装
  - DecayWatcher: 衰减规则检查
- `skills/remx-skill/references/` — CLI 手册 + 记忆写作指南

**打包配置**
- 正确的 `pyproject.toml`（name=remx，entry points）
- 更新的 `README.md`
- 更新的 `.gitignore`
- 新增 `setup.py`（向后兼容）

### 测试状态
所有 Phase 1 命令已实测通过，Skill 组件为文档化状态（供 AI Agent 遵循调用约定）

---

创建 PR 命令：
```bash
cd /path/to/RemX
gh pr create --base master --head impl --title "RemX v0.2.0: Phase 1 CLI engine + Skill documentation"
```
