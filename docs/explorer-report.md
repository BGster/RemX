# RemX 项目探索报告

**探索者：** Explorer | **日期：** 2026-04-02 | **分支：** impl

---

## 1. 项目定位

**RemX** = **Rem**ember e**X**tensible

一个数据驱动的个人知识管理系统（PKM），所有业务逻辑通过 `meta.yaml` 配置定义，CLI 仅负责索引引擎和检索。

**当前阶段：** v0.2.0，正在从 v1（僵化硬编码）向 v2（完全可配置架构）迁移。`impl` 分支实现 Phase 1。

---

## 2. 设计文档理解

### tech-spec.md（v1 命令规范）
定义了 11 个 `pm` 用户层命令：`init`、`log`、`demand`、`issue`、`principles`、`knowledge`、`tmp`、`version`、`list`、`search`，以及 CRUD 操作（update/delete/get）。**这是 v1 遗留文档，不是当前开发目标。**

### design-v2.md（v2 架构蓝图）
定义了新架构，Phase 边界清晰：

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | CLI 引擎层：`parse` `init` `index` `gc` `retrieve` | ✅ 已实现 |
| Phase 2 | Skill 协调层：ChunkSplitter、FileManager、ContextAssembler | ❌ 未实现 |
| Phase 3 | 工具链：meta.md 生成器、validate 命令、向量重建工具 | ❌ 未实现 |
| Phase 4 | 进阶：多 embedding 模型、增量索引、分布式部署 | ❌ 未实现 |

---

## 3. CLI 实际命令（remx/ cli.py）

**共 6 个命令，全部属于 Phase 1：**

| 命令 | 功能 | 对应 design-v2 |
|------|------|----------------|
| `remx parse <meta.yaml>` | 验证配置，输出 JSON | ✅ |
| `remx init [--reset]` | 解析 meta.yaml，创建/重建所有表和向量索引 | ✅ |
| `remx index <path>` | 索引单个文件（触发衰减计算） | ✅ |
| `remx gc [--dry-run] [--purge]` | 衰减召回清理 | ✅ |
| `remx retrieve --filter <json>` | 检索（只筛选不加工），返回 JSON | ✅ |
| `remx version` | 版本信息 | ✅ |

**缺失的 Phase 1 命令：**
- `remx chunk_info <path>` — 返回文件 chunks 列表
- `remx file_meta <path>` — 返回文件 header 元数据
- `remx tables` — 列出当前所有表结构
- `remx validate` — meta.yaml vs DB schema 一致性检查

---

## 4. 代码模块结构

```
remx/
├── __init__.py        # 包入口，__version__
├── __main__.py        # python -m remx 入口
├── cli.py             # Typer CLI（6个命令）
├── config.py          # 配置文件读取
├── chunker.py         # 语义切分（heading/paragraph 双策略）
├── db.py              # SQLite + sqlite-vec 底层操作
├── embedding.py       # embedding 创建（ollama / openai）
├── gc_.py             # gc 命令实现
├── gc.py              # 衰减逻辑
├── idgen.py           # ID 生成器
├── index_.py          # index 命令实现
├── init_.py           # init 命令实现
├── parse.py           # parse 命令实现
├── retrieve_.py       # retrieve 命令实现
├── schema.py          # MetaYaml 配置类 + EmbedderConfig
├── storage.py         # 文件系统操作
├── commands/          # 子命令目录（结构未知，需进一步探索）
├── build/             # 构建产物
└── .venv/            # Python 虚拟环境
```

**与 design-v2 的对应关系：**
- `cli.py` + 5 个 `*_.py` = CLI 引擎层 ✅
- `chunker.py` = Chunk 切割逻辑（Phase 2 需 Skill 封装）✅
- `schema.py` = meta.yaml 解析 ✅
- `db.py` = 数据层（SQLite + vec）✅
- **缺失 Phase 2 Skill 层**（FileManager、ContextAssembler 等）

---

## 5. Phase 边界分析

### Phase 1 已完成 ✅
- CLI 引擎 5 核心命令（parse/init/index/gc/retrieve）
- SQLite + sqlite-vec 数据层
- meta.yaml 解析器
- chunk 切割（heading / paragraph 双策略）
- GC 三模式（--dry-run / soft / --purge）
- 向量索引写入

### Phase 1 未完成 ⚠️
- `remx chunk_info`、`remx file_meta`、`remx tables`、`remx validate`（design-v2 明确列出）
- 向量语义搜索（retrieve 仅支持 filter，不支持语义检索）
- schema 缺少 `user_id` 列（tech-spec v1 定义但 design-v2 已淡化）
- N3、N7 两个功能性 bug（review-deep.md 记录）

### Phase 2 未开始 ❌
- Skill 协调层（唯一调用方）
- FileManager（文件 CRUD）
- ContextAssembler（上下文组装）
- 多 embedding 模型支持

---

## 6. impl 分支状态

**HEAD:** `b08de9c` — revert: undo test-deep.md and review-deep.md (fresh review requested)

**最近 5 个 commit：**
```
b08de9c revert: undo test-deep.md and review-deep.md (fresh review requested)
d1fedf6 docs: add deep test report for RemX v0.2.0 (B1 issue confirmed)
76a5dc7 docs: add deep review report (B1 fix verification + new blockers)
3cd1fc7 feat: split env docs into env-check.md and env-setup.md
3cac526 fix: simplify Linux section - uv handles Python automatically
```

**git status:** clean（无未提交修改）

**最近 diff（HEAD~1）：** 删除了 `docs/test-deep.md` 和 `docs/review-deep.md`（被 revert 掉了）

---

## 7. 关键发现

1. **tech-spec.md 是 v1 遗留文档** — 描述的命令（pm init/log/demand/issue 等）与当前 `impl` 分支实现完全不匹配。当前 CLI 只有 `remx` 前缀命令，不是 `pm` 前缀。

2. **Phase 1 范围有个微妙 gap** — design-v2.md 列出了 8 个 Phase 1 命令，但代码只实现了 6 个（缺少 `chunk_info`、`file_meta`、`tables`、`validate`）。

3. **两个功能性 bug 未修复** — review-deep.md（N3: retrieve 字符串参数处理；N7: index_.py f-string 未插值）被 revert 掉了，没有出现在 diff 中，说明还没有被正式修复。

4. **Phase 2 架构清晰但代码零实现** — Skill 层（MemoryFileManager、ChunkSplitter、ContextAssembler）在 design-v2.md 中有完整设计，但代码中完全没有这些模块。

5. **模块命名混乱** — `gc.py` 和 `gc_.py` 同时存在，`index_.py` 和 `storage.py` 职责有重叠，需要整理。

---

*本报告由 Explorer subagent 生成，2026-04-02*
