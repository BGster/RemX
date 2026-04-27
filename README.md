# RemX — 配置驱动的项目外部记忆系统

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心特性

- **向量语义检索** — 基于 sqlite-vec，支持 Ollama bge-m3 / OpenAI 文本嵌入
- **配置驱动** — 通过 `meta.yaml` 定义索引范围、衰减规则、向量维度
- **Heading 层级切分** — 按 Markdown H1/H2/H3 标题自动切分语义单元
- **自动衰减** — 支持 TTL / stale_after / never 三种衰减策略
- **CLI + Skill 双接口** — 适合人类使用，也适合 AI Agent 调用

## 模块结构

| 包 | 说明 |
|----|------|
| `@bgster/remx-core` | TypeScript CLI 核心 runtime（索引/检索/GC/拓扑） |
| `@bgster/remx-plugin` | OpenClaw 插件（hook + skill 封装） |
| `skills/remx/` | AI Agent 调用的 Skill 接口 |

## 安装

### 方式一：OpenClaw 插件模式（推荐）

```bash
cd /path/to/your-project
npm install @bgster/remx-core
# 然后在 OpenClaw 配置中启用 @bgster/remx-plugin
```

### 方式二：独立 CLI

```bash
npm install @bgster/remx-core
npx remx --help
```

### 开发安装

```bash
git clone https://github.com/BGster/RemX.git
cd RemX
npm install
cd remx-core && npm run build   # 构建 CLI
cd ../remx && npm run build    # 构建插件
```

## 快速开始

```bash
# 1. 初始化
remx init --reset --db ./memory.db --meta ./meta.yaml

# 2. 创建记忆文件
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
| `remx retrieve --query "<text>"` | 语义检索 |
| `remx relate <node> <relation> <target>` | 建立拓扑关系 |
| `remx gc [--dry-run]` | GC 清理（预览或执行）|
| `remx stats` | 数据库统计 |
| `remx parse <meta.yaml>` | 验证 meta.yaml 格式 |
| `remx version` | 输出版本号 |

详细文档 → `docs/ARCHITECTURE-ANALYSIS.md` / `docs/CLI-TEST-PLAN.md`

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

## OpenClaw 插件（Skill 接口）

参考 `skills/remx-skill/SKILL.md`

四大组件：
- **MemoryFileManager** — 写/更新/删除记忆文件
- **ChunkSplitter** — 验证 heading 结构
- **ContextAssembler** — 检索并组装上下文
- **DecayWatcher** — 检查衰减阈值

在 OpenClaw 中启用：

```json
{
  "plugins": {
    "entries": {
      "@bgster/remx-plugin": {
        "enabled": true,
        "config": {
          "dbPath": "./.remx/memory.db",
          "metaPath": "./.remx/meta.yaml"
        }
      }
    }
  }
}
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build          # 构建所有包

# 测试
npm test               # remx-core 测试
cd remx && npm test    # @bgster/remx-plugin 测试
```

## License

MIT