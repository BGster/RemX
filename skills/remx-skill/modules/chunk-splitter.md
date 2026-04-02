# ChunkSplitter

在写入记忆文件之前，验证 heading 结构是否合理，并给出切割建议。**只读不写**，输出建议而非执行操作。

## 核心职责

- 验证 Markdown 文件的 heading 层级是否规范
- 预览 `remx index` 的预期切分结果
- 在 write 之前给出修改建议，避免切分出低质量的 chunk

## 验证规则

### 层级跳跃检查

```
H1 → H2 → H3 ✓ 合法
H1 → H3 ✗ 跳跃（H2 被跳过）
H1 → H4 及以上 ✗ 超出 heading_levels 配置范围
```

### 段落长度检查

```
单段落 token 数 > max_tokens（meta.yaml chunk.max_tokens）
  → 会被按句子断句，可能破坏语义完整性
  → 给出警告，建议拆分段落
```

### 列表完整性检查

```
列表项和子标题之间不能有 H2/H3/H4
  e.g.
  ## 功能列表        ← chunk 边界
  - 项1
  - 项2
  ### 实现细节       ← 不合法！列表被标题切断了
  - 项3              ← 这条会跑到另一个 chunk
```

## 操作接口

### validate(file_path_or_content) → ValidationResult

**输入：** 文件路径或 markdown 文本
**输出：**
```json
{
  "valid": true,
  "issues": [],
  "warnings": []
}
```

或
```json
{
  "valid": false,
  "issues": [
    { "type": "heading_skip", "line": 12, "message": "H1 后直接跳到 H3，缺少 H2" }
  ],
  "warnings": [
    { "type": "section_too_long", "line": 20, "tokens": 823, "max": 512 }
  ]
}
```

### advise(file_path_or_content) → list[Advice]

**输入：** 同上
**输出：** 可操作的修改建议列表

```json
[
  {
    "type": "split_heading",
    "at_line": 15,
    "suggest": "在第 15 行前插入 H2 标题 '子主题A'",
    "reason": "当前 H1 下的内容超过 512 tokens，需要在语义完整处切分"
  },
  {
    "type": "merge_heading",
    "at_line": 30,
    "suggest": "将第 30 行的 H3 降为普通文本或合并到上一个 H3",
    "reason": "该 H3 只有 50 tokens，碎片化严重"
  }
]
```

### preview(file_path_or_content) → list[Chunk]

**触发场景：** 用户想看文件会被切成哪几个 chunk

**输出：** 模拟 `remx index` 的切分结果

```json
[
  {
    "chunk_id": "project::demands/feature-A.md::0",
    "heading": "# Feature-A 认证模块",
    "heading_level": 1,
    "para_indices": [0, 1, 2],
    "token_count": 412,
    "content_preview": "# Feature-A 认证模块\n\n负责处理用户登录..."
  },
  {
    "chunk_id": "project::demands/feature-A.md::1",
    "heading": "## 登录流程",
    "heading_level": 2,
    "para_indices": [3, 4, 5],
    "token_count": 380,
    "content_preview": "## 登录流程\n\n用户提交用户名+密码..."
  }
]
```

## 与 MemoryFileManager 的协作

```
用户: "记住这个决定"
        ↓
ChunkSplitter.validate()  ← 先检查结构
        ↓
[有问题?] → advise() → 用户/Agent 修正
        ↓
MemoryFileManager.write()  ← 确认无误后再写
```

validate 通过的情况下，write 可以跳过 advise 直接执行。

## 配置依赖

依赖 `meta.yaml` 中的：
- `chunk.max_tokens` — 段落最大 token 数
- `chunk.heading_levels` — 合法的标题级别
- `chunk.strategy` — heading | paragraph

若未读取 meta.yaml，使用默认值（max_tokens=512, heading_levels=[1,2,3]）。
