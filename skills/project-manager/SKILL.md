# Project-Manager Skill

项目记忆与知识管理工具。

## 触发场景

当用户提到以下内容时使用此 Skill：
- 创建需求、任务、子任务
- 记录问题、Bug、风险
- 记录开发原则、架构决策
- 记录会议要点、知识笔记
- 搜索/查询项目记忆
- 查看工作进度、日报

## 目录结构

```
project-manager/
├── .pm.yaml              # 配置文件
├── memory.db             # SQLite + sqlite-vec 向量数据库
├── share/                # 项目共享（全局可见）
│   ├── projects/         # PRJ-xxx.md
│   ├── milestones/       # MS-xxx.md（含版本发布）
│   ├── meetings/         # 会议记录
│   ├── issues/           # ISC-xxx.md（问题 + 风险）
│   └── knowledge/        # 知识库 + 参考资料
└── {user}/               # 用户私有工作区
    ├── principles/       # 开发原则 + ADR
    ├── daily/            # 开发日志
    ├── demands/          # DMD-xxx.md（个人任务）
    └── tmp/              # 临时指令（24h 物理删除）
```

## 核心命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `pm init --user <name>` | 初始化用户目录 | `pm init --user zeki` |
| `pm log --content <text>` | 记录日志 | `pm log --content "完成模块A"` |
| `pm demand --content <text>` | 创建需求 | `pm demand --content "实现登录功能"` |
| `pm issue --content <text>` | 创建问题 | `pm issue --content "数据库连接泄漏"` |
| `pm principles --content <text>` | 记录原则 | `pm principles --content "所有API需鉴权"` |
| `pm knowledge --content <text>` | 添加知识 | `pm knowledge --content "JWT最佳实践"` |
| `pm tmp --content <text>` | 临时笔记 | `pm tmp --content "周一开会"` |

## 记忆 ID 格式

| 前缀 | 类别 | 位置 |
|------|------|------|
| PRJ- | 项目信息 | share/projects/ |
| MS- | 里程碑 | share/milestones/ |
| DMD- | 需求 | share/demands/ 或 {user}/demands/ |
| ISC- | 问题/风险 | share/issues/ |

## 状态

- 需求：draft → approved → in_progress → verified → delivered
- 问题：open → in_progress → resolved → closed

## 扩展属性

记录时可通过 `--extension` 添加 JSON 格式的额外属性：

```bash
pm issue --content "性能问题" --extension '{"impact": "高", "owner": "zeki"}'
```
