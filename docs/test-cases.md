# Project-Manager 测试用例文档

> 测试工程师：Tester | 基于：`docs/tech-spec.md` v1.0 + `docs/adr-001-technical-architecture.md` | 日期：2026-03-31

---

## 测试用例编号：TEST-001
### 描述
`pm init` 首次初始化成功，目录和文件创建正确
### 前置条件
- 项目目录为空（无 `.pm.yaml`、`memory.db`、无 `share/`、无用户目录）
- 当前用户为 `zeki`
### 测试步骤
1. 在空目录下执行 `pm init --user zeki`
2. 检查 `.pm.yaml` 是否存在并包含正确字段（`current_user: zeki`，`db_path: memory.db`，`share_root: share`）
3. 检查 `memory.db` 是否存在且包含 `memories` 表和 `memories_vec` 虚拟表
4. 检查 `share/` 目录及其 5 个子目录是否创建（`share/projects/`、`share/milestones/`、`share/meetings/`、`share/issues/`、`share/knowledge/`）
5. 检查 `{user}/` 目录及其 4 个子目录是否创建（`zeki/principles/`、`zeki/daily/`、`zeki/demands/`、`zeki/tmp/`）
### 预期结果
- `.pm.yaml` 配置文件内容正确
- `memory.db` 数据库文件存在，schema 完整
- `share/` 和 `zeki/` 目录结构与 tech-spec.md 第 2.1 节流程图完全一致
- 命令输出包含成功初始化的 Rich 格式提示

---

## 测试用例编号：TEST-002
### 描述
重复初始化（无 `--force`）报错，不覆盖已有目录
### 前置条件
- `pm init --user zeki` 已执行完毕（目录已存在）
### 测试步骤
1. 再次执行 `pm init --user zeki`（无 `--force`）
2. 检查命令返回是否为错误/警告
3. 检查已有目录和文件是否未被修改/覆盖
### 预期结果
- 命令报错或警告，提示用户目录已存在
- `share/` 和 `zeki/` 目录内容保持不变
- `memory.db` 未被重新初始化

---

## 测试用例编号：TEST-003
### 描述
带 `--force` 重新初始化，目录和文件正确覆盖
### 前置条件
- `pm init --user zeki` 已执行完毕
- `zeki/daily/2026-03-31.md` 等文件已存在
### 测试步骤
1. 在某用户目录（如 `zeki/daily/`）下预先创建测试文件
2. 执行 `pm init --user zeki --force`
3. 检查目录结构是否重新创建
4. 验证预先创建的测试文件是否被清空或重新初始化（目录级覆盖）
5. 检查 `memory.db` 是否重新初始化（表结构存在，但数据清空或重新创建）
### 预期结果
- `--force` 标志使 `pm init` 成功执行（不报已存在错误）
- `share/` 和 `zeki/` 目录结构正确重建
- 重新初始化过程不报错

---

## 测试用例编号：TEST-004
### 描述
`pm log` 创建日志文件，格式正确，内容追加到同一日期文件
### 前置条件
- `pm init --user zeki` 已执行
- 当前日期为 `2026-03-31`
### 测试步骤
1. 执行 `pm log --content "完成模块A开发"`
2. 检查 `zeki/daily/2026-03-31.md` 是否创建
3. 检查文件格式是否包含时间戳标题（如 `## 09:00`）和 `- 任务：xxx` 格式
4. 再次执行 `pm log --content "修复Bug"`
5. 检查同文件是否追加了新内容（不是覆盖）
6. 使用 `--date 2026-03-30` 执行 `pm log`，检查是否创建了 `zeki/daily/2026-03-30.md`
### 预期结果
- 日志文件路径为 `{user}/daily/{YYYY-MM-DD}.md`
- 文件格式符合 tech-spec.md 第 1.2 节模板（`## HH:MM` + `- 任务：` + `- 进度：`）
- 同一日期多次 `pm log` 追加而非覆盖
- `--date` 参数正确创建对应日期的文件

---

## 测试用例编号：TEST-005
### 描述
`pm demand` 创建需求，带正确 Front-matter
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm demand --content "实现用户登录功能" --priority P1 --status open`
2. 检查 `zeki/demands/DMD-001.md` 是否创建
3. 检查文件是否包含正确的 Front-matter（`id: DMD-001`、`category: demand`、`priority: P1`、`status: open`）和正文内容
4. 再次执行 `pm demand --content "第二个需求"`，检查 ID 是否为 `DMD-002`
5. 检查数据库 `memories` 表是否记录了新的 demand 条目
### 预期结果
- 文件路径为 `{user}/demands/DMD-{序号}.md`
- Front-matter 包含 `id`、`category`、`priority`、`status`、`created_at`、`updated_at` 等字段
- 正文包含 "实现用户登录功能" 内容
- 数据库 `memories` 表中 `category='demand'` 的记录存在

---

## 测试用例编号：TEST-006
### 描述
`pm issue` 创建问题，存入 `share/issues/`
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm issue --content "数据库连接泄漏" --priority P1 --type bug`
2. 检查 `share/issues/ISC-001.md` 是否创建
3. 检查文件格式是否符合 tech-spec.md 第 1.4 节 issue 模板
4. 再次执行 `pm issue --content "第二个问题"`，检查 ID 是否为 `ISC-002`
5. 确认 issue 存放在 `share/` 而非用户私有目录
### 预期结果
- 文件路径为 `share/issues/ISC-{序号}.md`
- Front-matter 包含 `type: bug`、`priority: P1`、`status: open`
- 文件存储在 `share/` 下（全局共享）
- ID 自增正确

---

## 测试用例编号：TEST-007
### 描述
`pm tmp` 创建临时笔记，包含过期时间，不写入数据库
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm tmp --content "周一开会讨论项目进度" --ttl 24`
2. 检查 `zeki/tmp/TMP-*.md` 文件是否创建（文件名含随机短 ID）
3. 检查文件是否包含过期时间元信息（`过期时间` 或 `expires_at`）
4. 检查 `memory.db` 中是否存在该 tmp 条目（预期：**不存在**）
5. 使用 `--ttl 1` 创建另一个 tmp（1小时后过期）
6. 检查过期时间字段是否为 1 小时后
### 预期结果
- 文件路径为 `{user}/tmp/TMP-{随机ID}.md`
- 文件包含 `创建时间`、`过期时间`、`TTL` 元信息
- `memory.db` 中 **无** 该 tmp 记录（`category='tmp'` 的记录不存在于 DB）
- TTL 参数正确生效

---

## 测试用例编号：TEST-008
### 描述
ID 自增正确（首个为 DMD-001，第二个为 DMD-002）
### 前置条件
- `pm init --user zeki` 已执行，`zeki/demands/` 为空
### 测试步骤
1. 执行 `pm demand --content "需求1"`
2. 检查 ID 为 `DMD-001`
3. 执行 `pm demand --content "需求2"`
4. 检查 ID 为 `DMD-002`
5. 再执行 3 次，确认 ID 依次为 `DMD-003`、`DMD-004`、`DMD-005`
6. 执行 `pm issue --content "问题1"`，确认 issue ID 从自己的序列（ISC-001）开始而非沿用 demand 的序号
### 预期结果
- `DMD-` 序号在 demands 范围内全局自增（不受 issue 影响）
- `ISC-` 序号在 issues 范围内全局自增（不受 demand 影响）
- 各 category（PRJ-、MS-、ISC-、KNW-、DMD-）各自独立自增

---

## 测试用例编号：TEST-009
### 描述
tmp 文件过期后被物理删除，非 tmp 文件不受影响
### 前置条件
- `pm init --user zeki` 已执行
- 使用 `--ttl 1` 创建了一个 tmp 文件（1小时后过期）
### 测试步骤
1. 创建 tmp 文件后，手动将其 `过期时间` 修改为过去时间（如 `2026-03-30`）
2. 执行任意 `pm` 命令（如 `pm list`），触发惰性清理
3. 检查该 tmp 文件是否被物理删除
4. 验证同目录下其他非 tmp 文件或正常 tmp 文件不受影响
### 预期结果
- 过期 tmp 文件在下次 `pm` 命令执行时被物理删除（unlink）
- 清理过程不报错（文件损坏/无法解析时保留）
- 非 tmp 文件（demands、daily 等）完全不受影响

---

## 测试用例编号：TEST-010
### 描述
tmp 文件超过 TTL 后，后台 GC 清理（非惰性触发）
### 前置条件
- `pm init --user zeki` 已执行
- `pm daemon` 守护进程已启动（或系统 cron 已配置 `pm gc --expired`）
### 测试步骤
1. 创建 `--ttl 1` 的 tmp 文件
2. 等待超过 TTL（1小时）
3. 执行 `pm gc --expired`
4. 检查 tmp 文件是否被删除
5. 检查 `memory.db` 中是否同步删除（若 GC 同时清理 DB）
### 预期结果
- `pm gc --expired` 命令清理了所有已过期的 tmp 文件
- 数据库记录同步清理（若 GC 实现包含 DB 清理）

---

## 测试用例编号：TEST-011
### 描述
数据库 memories 表记录正确，含所有必要字段
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm demand --content "测试需求" --priority P2 --status open --tags "test,qa"`
2. 查询 `memory.db` 中 `memories` 表：`SELECT * FROM memories WHERE category='demand' ORDER BY created_at DESC LIMIT 1`
3. 检查记录字段：`id`、`category`、`user_id`、`title`、`content`、`priority`、`status`、`tags`、`file_path`、`created_at`、`updated_at` 均存在且正确
4. 检查 `memories_vec` 虚拟表：`SELECT * FROM memories_vec` 确认 embedding 记录存在
### 预期结果
- 数据库记录的所有字段与 tech-spec.md 第 3 节 schema 一致
- `id` = `DMD-001`（示例）
- `category` = `demand`
- `user_id` = `zeki`
- `tags` 为 JSON 数组格式 `["test","qa"]`
- `memories_vec` 中存在对应的向量记录（非 tmp 类型）

---

## 测试用例编号：TEST-012
### 描述
向量检索返回相关结果，排除 tmp 类型
### 前置条件
- `pm init --user zeki` 已执行
- Ollama/OpenAI embedder 已配置且可用
- 数据库中已有至少 3 条记忆（如 2 条 demands、1 条 issue）
### 测试步骤
1. 执行 `pm demand --content "实现用户认证模块"`
2. 执行 `pm demand --content "添加日志记录功能"`
3. 执行 `pm issue --content "数据库性能问题"`
4. 执行 `pm tmp --content "临时想法：重构缓存层"`（不进入向量库）
5. 执行 `pm search --query "用户身份验证"`（语义接近 "用户认证模块"）
6. 检查返回结果是否包含"实现用户认证模块"相关需求
7. 检查返回结果中 **不包含** tmp 条目
### 预期结果
- `pm search` 返回相关记忆（向量相似度最高的条目）
- tmp 条目（即使内容语义相关）**不在**搜索结果中
- 返回结果包含 Rich table 格式，显示 ID、category、score 等信息

---

## 测试用例编号：TEST-013
### 描述
不同用户目录隔离，各用户私有目录互不可见
### 前置条件
- `pm init --user zeki` 已执行
- `pm init --user test01` 再次执行（创建第二个用户）
### 测试步骤
1. 以 `zeki` 用户身份执行 `pm demand --content "zeki的需求"`
2. 以 `test01` 用户身份执行 `pm demand --content "test01的需求"`
3. 检查 `zeki/demands/` 目录下只有 `zeki` 创建的文件
4. 检查 `test01/demands/` 目录下只有 `test01` 创建的文件
5. 验证 `zeki` 无法在 `test01/` 目录下创建/读取文件
6. 执行 `pm list --user zeki` 和 `pm list --user test01`，检查各自列表是否隔离
### 预期结果
- `zeki/demands/` 和 `test01/demands/` 完全隔离
- 各用户的 `principles/`、`daily/`、`demands/`、`tmp/` 均仅对该用户可见
- `pm list` 默认仅列出当前用户记忆，`--user` 参数可切换查看其他用户

---

## 测试用例编号：TEST-014
### 描述
`share/` 目录全局共享，多用户均可读写
### 前置条件
- `pm init --user zeki` 已执行
- `pm init --user test01` 已执行
### 测试步骤
1. 以 `zeki` 身份执行 `pm issue --content "共享问题：支付接口故障"`
2. 检查 `share/issues/ISC-001.md` 存在
3. 以 `test01` 身份执行 `pm knowledge --content "API设计规范文档"`
4. 检查 `share/knowledge/KNW-001.md` 存在
5. 以 `zeki` 身份执行 `pm list --category issue`，确认能列出 `ISC-001`
6. 执行 `pm search --query "支付"`（跨用户/共享目录检索）
### 预期结果
- `share/` 下所有子目录（issues、knowledge、projects、milestones、meetings）全局共享
- `zeki` 创建的 issue 对 `test01` 可见
- `test01` 创建的 knowledge 对 `zeki` 可见
- `share/` 下记录的 `user_id` 为 `NULL`

---

## 测试用例编号：TEST-015
### 描述
`pm list` 命令按 category、user、status 正确过滤
### 前置条件
- `pm init --user zeki` 已执行
- 数据库中已有 demands（open/in_progress）、issues（open）、daily 多种类型
### 测试步骤
1. 执行 `pm list`，检查是否返回所有记忆（默认 limit=50）
2. 执行 `pm list --category demand`，检查是否仅返回 demands
3. 执行 `pm list --category issue`，检查是否仅返回 issues
4. 执行 `pm list --status open`，检查是否返回所有 open 状态的记录
5. 执行 `pm list --limit 1`，检查是否仅返回 1 条记录
6. 执行 `pm list --user test01`（test01 用户无数据），检查是否返回空列表
### 预期结果
- `pm list` 输出 Rich table，包含 ID、category、title、status 等列
- 过滤条件精确生效（category + status + user 可组合）
- `limit` 参数正确限制返回条数

---

## 测试用例编号：TEST-016
### 描述
`pm update` 更新记忆状态，同步更新文件和数据库
### 前置条件
- `pm init --user zeki` 已执行
- `zeki/demands/DMD-001.md` 已存在
### 测试步骤
1. 执行 `pm update DMD-001 --status in_progress`
2. 检查 `zeki/demands/DMD-001.md` 的 Front-matter 中 `status` 已更新为 `in_progress`
3. 检查 `updated_at` 字段已更新为当前时间
4. 检查数据库 `memories` 表中对应记录的 `status` 和 `updated_at` 是否同步更新
### 预期结果
- 文件和数据库同步更新
- `updated_at` 字段自动更新为最新时间
- `pm get DMD-001` 能看到最新状态

---

## 测试用例编号：TEST-017
### 描述
`pm delete` 删除记忆，文件和数据库记录同步删除
### 前置条件
- `pm init --user zeki` 已执行
- `zeki/demands/DMD-001.md` 已存在
### 测试步骤
1. 确认 `zeki/demands/DMD-001.md` 存在
2. 执行 `pm delete DMD-001`
3. 检查文件是否被物理删除
4. 检查 `memory.db` 中 `memories` 表和 `memories_vec` 表中对应记录是否同步删除
5. 执行 `pm get DMD-001`，检查是否报错（not found）
### 预期结果
- 文件和数据库记录完全删除（cascade delete）
- `pm get` 返回 not found 错误

---

## 测试用例编号：TEST-018
### 描述
配置热加载：修改 `.pm.yaml` 后立即生效，无需重启
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm list --category demand`（正常工作）
2. 修改 `.pm.yaml`，将 `current_user` 从 `zeki` 改为 `test01`
3. 再次执行 `pm list --category demand`
4. 检查是否以 `test01` 身份执行（应读取 `test01/demands/`，空目录返回空）
5. 恢复 `.pm.yaml` 为 `zeki`
### 预期结果
- 配置变更后立即生效，无需重启 daemon 或重新执行 `pm init`
- `pm` 命令动态读取 `.pm.yaml`

---

## 测试用例编号：TEST-019
### 描述
多用户并发写入数据库（WAL 模式），数据一致
### 前置条件
- `pm init --user zeki` 已执行
- `pm init --user test01` 已执行
### 测试步骤
1. 同时（尽可能快速地）执行以下命令：
   - `zeki` 执行 `pm demand --content "zeki的需求A"`
   - `test01` 执行 `pm demand --content "test01的需求A"`
   - `zeki` 执行 `pm demand --content "zeki的需求B"`
2. 检查数据库中 `zeki` 和 `test01` 的 demand 记录均存在
3. 检查 ID 序列无交叉混乱（如 DMD-001/DMD-002 属于zeki，DMD-003 属于test01，或各自独立）
### 预期结果
- WAL 模式下并发写入不导致数据丢失或 ID 冲突
- 数据库记录与文件一一对应

---

## 测试用例编号：TEST-020
### 描述
ID 序号跨类别独立：demand 和 issue 各自使用独立序号
### 前置条件
- `pm init --user zeki` 已执行
### 测试步骤
1. 执行 `pm demand --content "需求1"`，确认为 `DMD-001`
2. 执行 `pm issue --content "问题1"`，确认为 `ISC-001`（而非 `DMD-002`）
3. 执行 `pm demand --content "需求2"`，确认为 `DMD-002`（而非 `ISC-002`）
4. 执行 `pm issue --content "问题2"`，确认为 `ISC-002`
5. 执行 `pm knowledge --content "知识1"`，确认为 `KNW-001`（独立序列）
### 预期结果
- 各 ID 前缀（`DMD-`、`ISC-`、`KNW-`、`PRJ-`、`MS-`）各自独立自增
- 不存在 ID 交叉（如 `ISC-003` 不会出现 demanded 序列中）

---

*文档版本：v1.0 | 测试工程师：Tester | 状态：待 Coder 实现后执行*
