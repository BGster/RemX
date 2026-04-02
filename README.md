# RemX — 配置驱动的项目外部记忆系统

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心特性

- **向量语义检索** — 基于 sqlite-vec，支持 Ollama bge-m3 / OpenAI 文本嵌入
- **配置驱动** — 通过 `meta.yaml` 定义索引范围、衰减规则、向量维度
- **Heading 层级切分** — 按 Markdown H1/H2/H3 标题自动切分语义单元
- **自动衰减** — 支持 TTL / stale_after / never 三种衰减策略
- **CLI + Skill 双接口** — 适合人类使用，也适合 AI Agent 调用

## 安装

```bash
git clone https://github.com/BGster/RemX.git
cd RemX
pip install -e ".[vec]"    # 安装依赖 + sqlite-vec 支持
```

或使用 uv：

```bash
uv pip install -e ".[vec]"
```

## 快速开始

```bash
# 1. 初始化
remx init --reset --db ./memory.db --meta ./meta.yaml

# 2. 创建记忆文件（参考 docs/memory-writing-guide.md）
echo '---
category: demand
priority: P1
---
# 认证模块决策

## 概述
使用 JWT Token 方案。
' > demands/auth-decision.md

# 3. 索引
remx index demands/auth-decision.md --db ./memory.db --meta ./meta.yaml

# 4. 检索
remx retrieve --db ./memory.db --filter '{"category":"demand"}'
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `remx init` | 初始化数据库和目录结构 |
| `remx index <file>` | 索引单个文件 |
| `remx retrieve --filter '<json>'` | 按条件检索记忆 |
| `remx gc [--dry-run]` | GC 清理（预览或执行）|
| `remx parse <meta.yaml>` | 验证 meta.yaml 格式 |
| `remx version` | 输出版本号 |

详细文档 → `docs/remx-cli-user-guide.md`

## meta.yaml 配置

```yaml
name: my-project
version: "1"

index_scope:
  - path: "demands/"
    pattern: "*.md"
  - path: "issues/"
    pattern: "*.md"

decay_groups:
  - name: tmp_ttl
    trigger: {category: tmp}
    function: ttl
    params: {ttl_hours: 1}

vector:
  dimensions: 768

chunk:
  strategy: heading
  max_tokens: 512
  overlap: 1
  heading_levels: [1, 2, 3]
```

## Skill 接口（AI Agent 使用）

参考 `skills/remx-skill/SKILL.md`

四大组件：
- **MemoryFileManager** — 写/更新/删除记忆文件
- **ChunkSplitter** — 验证 heading 结构
- **ContextAssembler** — 检索并组装上下文
- **DecayWatcher** — 检查衰减阈值

## 开发

```bash
# 本地开发安装
pip install -e ".[vec]"

# 运行测试
python -m pytest

# lint
ruff check remx/
```

## License

MIT
