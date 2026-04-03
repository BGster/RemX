# ContextAssembler

将 `remx retrieve` 的检索结果组装成 LLM 可直接使用的上下文文本。只读不写。

## 核心职责

- 接收用户的自然语言问题
- 构造合适的 filter 调用 `remx retrieve`
- 将 JSON 结果格式化为连贯的上下文文本
- 返回给 Agent 用于生成回答

## 操作接口

### assemble(query, options?) → string

**触发场景：** 用户问"我之前关于 X 的决定是什么"、"项目里有哪些 open 的 issue"

**动作流程：**
```
1. 解析 query，提取关键实体和意图
     - 实体：X 是什么（关键词）
     - 意图：查 demand？查 issue？查所有？

2. 构造 filter
     e.g.
     query: "关于认证模块的决定"
     → 先用 --query 语义搜索（自动返回相关记忆）
     
     query: "所有 open 的 bug"
     → { "category": "issue", "status": "open", "type": "bug" }

3. 调用 remx retrieve
     # 语义模式
     remx retrieve --query '<query>' --db <db> --meta <meta.yaml> [--decay-weight 0.5]
     # 过滤模式
     remx retrieve --filter '<json>' --db <db> [--limit 20] [--no-embed]

4. 组装上下文文本
     格式：
     ## 记忆上下文（{count} 条）

     [{chunk 1 heading}]
     {chunk 1 content}

     ---

     [{chunk 2 heading}]
     {chunk 2 content}

     ---

     ...

5. 返回文本
     → 直接塞进 LLM prompt 的上下文字段
```

### by_category(category, options?) → string

**触发场景：** 显式指定 category 检索

```
用户: "列出所有需求"
→ assemble(query="所有需求", options={category: "demand", require_content: true})
```

### by_filter(filter_json, options?) → string

**触发场景：** 高级用户或系统内部使用，直接传 filter JSON

```
remx retrieve --filter '{"category":"demand","priority":"P0","status":"open"}'
```

### format_single(memory_record) → string

将单条 memory + 其 chunks 格式化为文本，用于展示详情：

```
## {title}

**ID:** DEM-xxx
**Category:** demand
**Priority:** P1
**Status:** open
**Created:** 2026-04-01

---

{chunk content 1}

---

{chunk content 2}
```

## 上下文组装策略

### 截断策略

若所有 chunks 加起来的 token 数超过 LLM context 的预留空间（建议 ≤ 8k tokens），按优先级截断：

```
优先级顺序：
1. 最新创建的（created_at 降序）
2. chunk 内嵌的 heading 层级（越高越重要）
3. 用户 query 中关键词匹配度
```

### 多 chunk 拼接规则

同一个 memory 的多个 chunks：
- 按 `chunk_index` 升序拼接
- chunk 之间用 `\n\n---\n\n` 分隔
- 同一个 memory 的 chunks 始终在一起

不同 memory 之间：
- 按 `created_at` 降序排列（最新的在前）
- memory 之间用 `\n\n=======\n\n` 分隔

## 降级处理

| 场景 | 降级行为 |
|------|----------|
| `remx retrieve` 返回空 | 返回"未找到相关记忆" |
| `remx retrieve` 超时 | 返回"检索超时，请稍后重试" |
| embedding 服务不可用 | `remx retrieve` 会返回 LIKE 文本搜索结果（可接受） |

## 错误处理

| 场景 | 返回 |
|------|------|
| 检索失败（db 不存在） | "RemX 未初始化，请先运行 `remx init`" |
| filter JSON 格式错误 | "检索条件格式错误" |
| 零结果 | "没有找到匹配的记录" |
