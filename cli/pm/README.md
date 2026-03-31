# pm - Project-Manager CLI

项目记忆与知识管理命令行工具。

## 安装

```bash
cd cli/pm
uv pip install -e .
```

## 使用

```bash
pm --help
```

## 命令

- `pm init --user <name>` - 初始化用户
- `pm log --content <text>` - 记录日志
- `pm demand --content <text>` - 创建需求
- `pm issue --content <text>` - 创建问题
- `pm principles --content <text>` - 记录原则
- `pm knowledge --content <text>` - 添加知识
- `pm tmp --content <text>` - 临时笔记（24h）
