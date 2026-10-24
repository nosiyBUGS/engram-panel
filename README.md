# Engram 面板

一个很小的本地 Web 面板，用来查看、搜索、编辑、删除和恢复 Engram 记忆。

- 纯 Python 标准库服务，无第三方依赖
- 只监听 `127.0.0.1`
- 普通编辑和删除走 Engram 的 HTTP API（`PATCH/DELETE /observations/...`）
- 回收站恢复是唯一例外：Engram 没有恢复 API，面板默认在整库备份后直接清空 `deleted_at`，让 Engram 的 FTS 触发器重建索引
- 支持项目 / 类型 / 范围过滤，全文搜索，软删除、回收站恢复和永久删除
- 支持新建记忆
- 删除和恢复前自动用 SQLite 在线备份 API 生成整库快照；备份在 `backups/`，默认保留最近 20 份

## 启动

双击 `start-panel-silent.vbs`（Windows 无窗口启动），或者：

```powershell
cd engram-panel
.\start-panel.cmd
```

`start-panel-silent.vbs` 会调用 `pythonw.exe` 在后台启动面板；找不到时会尝试 `pyw.exe`。

浏览器会打开：

```text
http://127.0.0.1:8787/
```

如果 Engram 的 HTTP 服务（`engram serve 7437`）没有在运行，面板会自动启动它。  
如果已经有一个面板在运行，再次双击快捷方式只会打开浏览器，不会重复启动。

## 停止

- 点面板右上角的 **退出**，或
- 关闭运行 `start-panel.cmd` 的窗口，或
- 在任务管理器里结束 `pythonw.exe` / `python.exe`（只结束运行本面板的那个）。

退出面板不会删除记忆。如果 Engram 服务是面板自动启动的，面板退出时也会把它关掉；如果 Engram 本来就在运行，则保持运行。

## 功能

| 功能 | 说明 |
|---|---|
| 列表 | 最近记忆，按项目 / 类型 / 范围过滤 |
| 搜索 | Engram FTS5 全文搜索；搜索词建议至少 3 个字符 |
| 详情 | 查看标题、内容、类型、范围、topic_key、会话、时间、修订号 |
| 编辑 | 修改标题、内容、类型、范围、topic_key；保存走 `PATCH` |
| 删除 | 默认软删除，进入回收站；永久删除需要二次确认 |
| 回收站 | 列出 `deleted_at` 不为空的记忆；可恢复或永久删除 |
| 新建 | 自动创建一个 `engram-panel-*` 会话，再写入 observation |
| 统计 | 记忆 / 会话 / 项目数量；回收站数量显示在“回收站”标签上 |
| 备份 | 顶部“备份”按钮；每次删除和恢复前也会自动备份 |

## 删除、回收站与找回

| 操作 | 实际行为 | 能否找回 |
|---|---|---|
| **删除** | 软删除：设置 `deleted_at`，从列表、搜索、context 里隐藏，数据库行还在 | 在“回收站”标签里点 **恢复**；恢复前会自动备份整库 |
| **恢复** | 清空 `deleted_at`，Engram 的 FTS 触发器把记录重新写回搜索索引 | 恢复成功后回到普通列表和搜索结果 |
| **永久删除** | 硬删除：`DELETE FROM observations`，并写同步 tombstone | Engram 内无法恢复；只能从删除前的整库备份恢复 |

面板在每次删除（包括永久删除）和每次恢复之前，会先调用 SQLite 在线备份 API 生成：

```text
backups\engram-YYYYMMDD-HHMMSS-before-delete.db
backups\engram-YYYYMMDD-HHMMSS-before-restore.db
backups\engram-YYYYMMDD-HHMMSS-manual.db
```

备份启用时，如果备份失败，面板会取消这次删除或恢复，不会先改再报错。备份是整库快照，默认保留最近 20 份。

### 恢复与云同步

恢复只改本地 SQLite，不会经过 Engram 的同步队列。如果这个项目启用了 Engram Cloud：

- 恢复后本地能立刻看到记录，搜索也能找到；
- 但云端不一定会自动恢复这条记录；
- 面板会弹出提示；需要云同步时，建议恢复后打开记录点一次“保存修改”，或之后用 `engram sync --cloud` 检查。

### 恢复需要新版 SQLite

Engram 的 FTS5 索引使用 `trigram` 分词器，需要 SQLite 3.34+。面板本身可以用较旧的 Python 运行；如果当前 Python 的 SQLite 太旧，恢复时会自动寻找 `py -3.15`、`py -3.14`……或新版 `python.exe` 作为助手执行恢复。也可以手动指定：

```powershell
$env:PANEL_SQLITE_PYTHON = "C:\path\to\python.exe"
```

如果找不到新版 Python，恢复会返回 `no such tokenizer: trigram` 一类的错误，普通编辑和删除不受影响。

### 从备份恢复

1. 点面板右上角 **退出**，并确认没有其他 `engram` 进程在写数据库。
2. 把当前的 `%USERPROFILE%\.engram\engram.db` 改名留底。
3. 把 `backups\` 里选定的 `.db` 复制成 `%USERPROFILE%\.engram\engram.db`。
4. 如果存在 `engram.db-wal` / `engram.db-shm`，一并移走（不要和旧备份混用）。
5. 重新启动 Engram / 面板。

这会恢复到备份那一刻的整个数据库；备份之后的新记忆不会包含在内。

## 安全说明

- 面板只绑定 `127.0.0.1`，局域网访问不到。
- 更新和删除都会带 `expected_project`，避免误改其他项目的记忆。
- 普通编辑和删除不直接写 `engram.db`；只有回收站恢复会直接清空 `deleted_at`，并且默认会先成功生成整库备份再改。
- 恢复后 FTS 索引由 Engram 的触发器维护；同步队列不会自动补一条 upsert，云同步场景请按上面的说明处理。
- 如果设置了 `ENGRAM_HTTP_TOKEN`，面板会把 Bearer token 转发给 Engram。
- 这是本地工具，没有登录功能；不要在不可信的机器上长期运行。

## 可选环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PANEL_HOST` | `127.0.0.1` | 面板监听地址 |
| `PANEL_PORT` | `8787` | 面板端口 |
| `ENGRAM_URL` | `http://127.0.0.1:7437` | Engram HTTP API 地址 |
| `ENGRAM_BIN` | 自动查找 | `engram.exe` 路径 |
| `ENGRAM_DATA_DIR` | `~/.engram` | Engram 数据目录 |
| `ENGRAM_DB_PATH` | `%ENGRAM_DATA_DIR%\engram.db` | 直接指定数据库路径（备份用） |
| `ENGRAM_HTTP_TOKEN` | 空 | 如果 Engram 启用了 HTTP token |
| `PANEL_NO_BROWSER` | 空 | 设为 `1` 时不自动打开浏览器 |
| `PANEL_BACKUP` | `1` | 设为 `0` 关闭删除/恢复前自动备份（不建议） |
| `PANEL_BACKUP_KEEP` | `20` | 保留最近多少份备份 |
| `PANEL_SQLITE_PYTHON` | 自动查找 | 指定带新版 SQLite 的 `python.exe`，用于回收站恢复 |

## 文件

```text
engram-panel/
  server.py               Python 静态服务 + /api 代理 + 自动启动 Engram
  restore_worker.py       回收站恢复助手（给旧 Python 调用新版 SQLite）
  index.html              页面结构
  app.css                 样式
  app.js                  前端逻辑
  start-panel.cmd         带控制台启动
  start-panel-silent.vbs  无窗口启动
  logs/                   自动启动 Engram 时的日志
  backups/                删除/恢复前自动生成的整库备份
```

## 常见问题

**面板显示“Engram 未连接”**  
确认 `engram serve 7437` 在运行，或看 `logs/engram-serve.log`。

**搜索没有结果**  
Engram 使用 FTS5 trigram，太短的搜索词可能匹配不到；试试更长、更具体的关键词，或清空搜索后按项目/类型浏览。

**回收站恢复报 `no such tokenizer: trigram`**  
面板当前 Python 的 SQLite 太旧，又没找到新版 Python。安装 Python 3.10+，或设置 `PANEL_SQLITE_PYTHON` 指向新版 `python.exe`，然后重启面板。普通编辑和删除不需要这一步。

**改了记忆但 OpenCode / DSH 没马上看到**  
它们通过 MCP 读取 Engram；下一次调用 `mem_search` / `mem_context` 时会读到新内容。必要时重启对应的 agent 会话。

## 许可证

Apache License 2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
