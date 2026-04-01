# RemX 环境准备

RemX 需要 Python 3.11+ 和 SQLite（含 sqlite-vec 扩展）。以下是各系统详细安装步骤。

---

## 通用依赖

- Python 3.11 或更高版本
- `uv`（推荐）或 `pip`
- Git（可选，用于 clone 项目）

---

## macOS

### 1. 安装 Python

```bash
# 使用 Homebrew
brew install python@3.11

# 或使用 pyenv
pyenv install 3.11
pyenv local 3.11
```

### 2. 安装 uv

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 3. 创建虚拟环境并安装

```bash
cd RemX/remx
uv venv
source .venv/bin/activate
uv pip install -e .
```

---

## Linux（通用）

`uv` 自带 Python 管理器，**不需要预先安装系统 Python**。它会自动下载并使用所需版本。

### 1. 安装 uv

`uv` 自带 Python 管理器，会自动下载所需 Python 版本，无需单独装系统 Python。

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

> 如果官方脚本网络失败，可通过包管理器：`sudo apt install uv`（Debian/Ubuntu）或 `sudo dnf install uv`（Fedora）等。

### 2. 创建虚拟环境并安装

```bash
cd RemX/remx
uv venv
source .venv/bin/activate
uv pip install -e .
```

> `uv` 会自动处理 sqlite-vec 的 C 扩展编译（Linux 上使用自带 Python 的开发文件）。

---

## Windows（PowerShell / CMD）

### 1. 安装 Python

从 [python.org](https://www.python.org/downloads/) 下载并安装 Python 3.11+，安装时**勾选 "Add Python to PATH"**。

验证：
```powershell
python --version
```

### 2. 安装 uv

PowerShell：
```powershell
irm https://astral.sh/uv/install.ps1 | iex
```

或使用 pip：
```powershell
pip install uv
```

### 3. 创建虚拟环境并安装

```powershell
cd RemX\remx
uv venv
.venv\Scripts\activate
uv pip install -e .
```

### ⚠️ Windows 特殊说明

**sqlite-vec 编译问题：**

sqlite-vec 需要编译 C 扩展，Windows 上如果没有 C 编译器可能会失败：

```
error: Microsoft Visual C++ 14.0 or greater is required.
```

**解决方案：**

1. **方案一（推荐）：安装 Microsoft C++ Build Tools**
   - 下载 [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio)
   - 安装时勾选 "C++ 生成工具"
   - 重启终端，重新运行 `uv pip install -e .`

2. **方案二：使用预编译 wheel**
   ```powershell
   pip install sqlite-vec --only-binary=:all:
   uv pip install sqlite-vec --python .venv/bin/python
   ```

3. **方案三：使用 WSL**
   - 在 WSL2 中安装 RemX，体验与 Linux 完全一致
   - Windows 端通过 WSL IP 访问

**如果安装失败请提供以下信息：**
- Python 版本：`python --version`
- 完整错误信息（贴最后 20 行）
- Windows 版本（如 Windows 11 22H2）

---

## 验证安装

安装完成后，运行：

```bash
remx version
```

期望输出：`remx v0.2.0`

如果提示 `command not found`，尝试：
```bash
source .venv/bin/activate   # Linux/macOS/WSL
.venv\Scripts\activate      # Windows CMD
remx version
```

---

## 快速检查清单

| 检查项 | 命令 | 期望 |
|--------|------|------|
| Python 版本 | `python --version` | ≥ 3.11 |
| uv 安装 | `uv --version` | 显示版本号 |
| 虚拟环境 | `which remx` 或 `where remx` | 路径在 .venv 内 |
| 依赖完整 | `remx version` | `remx v0.2.0` |

---

## 向量模型配置（可选）

RemX 支持本地 Ollama 或 OpenAI API 向量嵌入。默认跳过（`--no-embed`），如需启用：

**Ollama：**
```bash
ollama pull bge-m3
```

**OpenAI：**
```bash
export OPENAI_API_KEY=sk-...
```

首次使用时 RemX 会提示配置。
