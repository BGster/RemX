# DecayWatcher

检查所有配置了衰减规则的记忆，对快到期的记忆发出提醒。**只读不写**，通过 `remx retrieve` 和 `remx gc --dry-run` 获取信息。

## 核心职责

- 读取 `meta.yaml` 的 `decay_groups` 配置
- 按 decay_group 的 trigger 条件查询对应的 memories
- 检查 `expires_at` / 计算 `stale_after` 是否快到期
- 对需要在衰减前引起注意的记忆发出提醒

## 衰减函数类型

| function | 行为 | 计算逻辑 |
|----------|------|----------|
| `ttl` | 绝对 TTL | `expires_at = now + ttl_hours`（固定，到期即删）|
| `stale_after` | 相对超时 | `expires_at = updated_at + days`（每次 re-index 刷新）|
| `never` | 永不过期 | 不检查，不警告 |

## 操作接口

### check(meta_yaml_path, db_path) → list[Warning]

**触发时机：**
- 每次 `remx index` 完成后自动触发
- Agent 主动查询时（`remx gc --dry-run`）

**动作流程：**
```
1. 加载 meta.yaml 的 decay_groups

2. 对每个 decay_group（function != "never"）：
   a. 构造 filter 查询条件
      e.g. trigger: {category: tmp, status: open}
      
   b. remx retrieve --filter '<json>'
   
   c. 对每条 record 检查：
      - ttl: 剩余时间 = expires_at - now
      - stale_after: 剩余时间 = expires_at - now（每次 re-index 刷新 updated_at）
      
   d. 若剩余时间 < 阈值（默认 24h）→ 记入 warning

3. 返回警告列表
```

**输出格式：**
```json
[
  {
    "memory_id": "TMP-xxx",
    "category": "tmp",
    "title": "会议纪要 2026-04-02",
    "expires_at": "2026-04-03T10:00:00Z",
    "remaining_hours": 16,
    "urgency": "normal"
  },
  {
    "memory_id": "DEM-yyy",
    "category": "demand",
    "title": "认证模块决策",
    "stale_at": "2026-04-03T00:00:00Z",
    "remaining_hours": 4,
    "urgency": "high"
  }
]
```

### urgency 判定规则

```
remaining_hours <= 4   → "critical"   （立即提醒）
remaining_hours <= 24  → "high"       （强烈提醒）
remaining_hours <= 72  → "normal"     （普通提醒）
remaining_hours > 72   → 不加入警告列表
```

### summarize(warnings) → string

将警告列表格式化为人类可读文本：

```
⚠️ 记忆即将衰减（3 条）

🔴 [critical] TMP-xxx "会议纪要 2026-04-02" — 剩余 4 小时
🟡 [high] DEM-yyy "认证模块决策" — 剩余 12 小时（stale_after）
🟡 [high] TMP-zzz "周报草稿" — 剩余 18 小时

如需保留，请更新文件后重新 index 以刷新 TTL。
```

## DecayWatcher vs ContextAssembler

| | DecayWatcher | ContextAssembler |
|---|---|---|
| **触发** | index 后 / gc 时 | 用户问问题时 |
| **方向** | 系统 → 用户/Agent | 用户/Agent → 系统 |
| **操作** | 读取 + 判断 + 提醒 | 读取 + 组装 |
| **写操作** | 无 | 无 |

## 配置阈值

阈值可通过 meta.yaml 配置：

```yaml
decay_watcher:
  warn_before_hours: 24     # 提前多久开始警告
  critical_hours: 4         # 低于此值标记为 critical
  enabled: true              # 是否启用
```

若未配置，使用默认值（warn_before_hours=24, critical_hours=4）。

## 典型使用场景

**场景 1：index 后的自动检查**
```
remx index demands/feature-A.md
  → DecayWatcher.check() 
  → 发现 tmp 类记忆剩余 2h 
  → 提醒用户："tmp 类记忆 '周报草稿' 即将在 2 小时后被 GC 清理"
```

**场景 2：用户询问项目状态**
```
用户: "项目里有哪些快过期的记忆"
→ DecayWatcher.check() 
→ 返回所有 urgency=high/critical 的记忆
```

**场景 3：Agent 主动触发**
```
Agent 在规划任务前
  → DecayWatcher.check() 
  → 发现关键需求被标记为 stale 
  → 决定先更新或确认是否继续
```
