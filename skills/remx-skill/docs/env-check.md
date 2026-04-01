# RemX 环境检测

在安装或调试之前，先检查当前环境是否满足要求。

---

## 快速检查清单

| 检查项 | 命令 | 期望结果 |
|--------|------|----------|
| Python 版本 | `python --version` | `Python 3.11` 或更高 |
| uv 安装 | `uv --version` | 显示版本号（如 `uv 0.5.x`）|
| uv Python 版本 | `uv python list` | 列表中有可用 Python |
| RemX 安装 | `remx version` | `remx v0.2.0` |
| SQLite 可用 | `sqlite3 --version` | 显示版本号 |
| 数据库可写 | `touch test.db && rm test.db` | 无报错 |

---

## 常见问题

### `remx: command not found`

虚拟环境未激活，或 RemX 未安装。

```bash
# 检查 remx 是否在 .venv 中
which remx
# 或 Windows:
where remx

# 如果不在 .venv，重新安装
cd RemX/remx
uv pip install -e .

# 激活虚拟环境（Linux/macOS/WSL）
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

### `uv: command not found`

uv 未安装。按系统查看安装步骤 → `skills/remx-skill/docs/env-setup.md`

### `Python version too old`

RemX 需要 Python 3.11+。

```bash
# 用 uv 安装指定版本
uv python install 3.11
uv venv --python 3.11
```

### `sqlite-vec` 加载失败

```bash
# 检查 sqlite3 版本
sqlite3 --version

# 在 Python 中测试
python -c "import sqlite3; print(sqlite3.sqlite_version)"
```

---

## 输出诊断信息

如果遇到问题，复制以下命令的输出：

```bash
echo "=== System ==="
uname -a

echo "=== Python ==="
python --version
which python

echo "=== uv ==="
uv --version
uv python list

echo "=== RemX ==="
remx version 2>&1 || echo "remx not found"

echo "=== SQLite ==="
sqlite3 --version
```

---
