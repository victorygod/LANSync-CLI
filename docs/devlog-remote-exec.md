# lansync 远程执行功能 · 开发日志

分支:`feature/remote-exec`(临时发布名 `lansyncopt`)
时间:2026-09-23 ~ 2026-09-25
设计文档:[remote-exec-design.md](remote-exec-design.md)

## 概览

在文件同步工具上增加远程命令执行能力:client 调 `lansyncopt exec "<命令>"`,命令在 server 机器的 rootDir 内执行,结果同步返回。核心场景是 agent 调用——agent 自己管超时,超时 kill client 后 server 端同步终止远端命令。

提交轨迹(每步均通过测试,工作树 clean 后才提交):

| Commit | 内容 |
|--------|------|
| `adeb7fa` | 设计文档初稿 |
| `21226f8` | 设计细化(exec 语法修正、agent 契约、token 作用域、改名方案、完整指令集) |
| `00ef277` | 改名 `lansyncopt` + 配置目录隔离 |
| `4b55153` | 清理测试残留目录 |
| `8c0a706` | 远程执行完整实现(策略模块、/api/exec、CLI、测试) |
| 本次 | 文档同步(实现与设计的偏差修正)+ README 改名 + 开发日志 |

## 关键设计决策与理由

1. **口令 → token 确定性派生**
   `token = HMAC-SHA256(key=口令, msg="lansync-cli-v1")`。双方 `enable-cli` 输入同口令即得到相同 token,无需网络握手;口令不落盘,只存 token。`LANSNC_PASSWORD` 环境变量支持非交互场景(agent)。

2. **token 仅作用于 `/api/exec`**
   pull/push 走的 `/api/list`、`/api/file` 不校验 token,与现有版本行为完全一致,向后兼容。

3. **三级分级管控 + `--policy`**
   黑名单(灾难性)/ 灰名单(高频半安全)/ 隐式白名单。`server enable-cli --policy` 三档:`allow-all` / `block-black`(默认)/ `block-black-gray`。
   匹配上采用**词边界前缀**而非裸前缀:`rm -rf /` 拦根删除但不误拦 `rm -rf /home/x/node_modules`;`sudo` 放进灰名单,`sudo su`/`sudo -i` 等精确项在黑名单先命中,靠「黑名单优先」顺序区分。

4. **断连即杀 + 进程组**
   `spawn(cmd, { shell: true, detached: true })` 建独立进程组;`req.on('aborted')` / `res.on('close')` 触发 `process.kill(-pid)` 先 SIGTERM、2 秒后 SIGKILL,防止 shell 子进程变孤儿。这是 agent 超时闭环(「超时即杀」)的实现基础。

5. **动态自引用检测只保留精确标识**
   server 执行前比对命令字符串与:自身 PID、`~/.lansyncopt` 配置目录、`server.js` 代码路径。**不含工具名裸子串**(`pkill -f lansync` 类威胁由黑名单精确项覆盖)——详见下文「开发中发现的问题」第 3 条。

6. **临时改名 `lansyncopt` 硬隔离**
   `package.json` name/bin、`src/config.js` 配置目录(`~/.lansync` → `~/.lansyncopt`)、`setup.sh`、`src/cli.js` 文案同步改名。目的:与已安装的 lansync 并存,**绝不覆盖**旧命令与旧配置。合并回 main 后再恢复原名。

7. **测试环境变量 `LANSNC_CONFIG_DIR`**
   允许覆盖配置目录,测试全部指向临时目录。这是测试安全的前提(见下)。

## 开发中发现的问题(都已修复)

### ⚠️ 最危险:`test-integration.js` 原来会 `rm -rf ~/.lansync`

老代码在 `beforeEach`/`afterEach` 里硬编码删除 `~/.lansync`——那是**真实安装**的 lansync 代码 + 配置。也就是说改动前跑一次 `npm test` 就会把已装的 lansync 删光。

修复:测试改用 `LANSNC_CONFIG_DIR` 指向临时目录,全程不碰真实 HOME。

### 集成测试与真实 server 抢 8001 端口

本机有个真实 lansync server 一直跑在 8001(已安装版),老集成测试硬编码 8001 导致 `server start` 冲突。

修复:`server start` 增加 `--port <n>` 参数(顺带的功能增强),测试用随机端口。

### 自引用检测裸子串误拦

初版把 `'lansync'`/`'lansyncopt'` 作为自引用标识做裸子串匹配,立即被自己的测试抓住:测试临时目录名含 `lansyncopt-exec-root-XXX` → exec 命令里带这个路径 → 被当成「自毁命令」403 掉。

修复:自引用检测只保留**精确运行时标识**(PID / 配置目录 / 代码路径);「按名杀 server」(`pkill -f lansync`、`taskkill /f /im node.exe`)由黑名单精确项覆盖。设计文档 4.5 已同步此修正。

### `dd if=` 条目写反

初稿注释写「裸设备写」,但 `if=` 是读方向。修正为直接拦整个 `dd`。

### 测试写脏真实配置目录

`test-server.js` 的路径遍历用例会触发 server 的 `log()`,在 `~/.lansyncopt` 留下 `server.log`。修复:`log()` 改为惰性取路径,`test-server.js` 顶部设置 `LANSNC_CONFIG_DIR` 到临时目录,并清理了已写入的文件。

### Windows 下 daemon 静默死亡 + `server start` 假装成功

实测跨机器使用时发现(Windows 服务端):daemon 路径用 `new URL(import.meta.url).pathname` 构造,在 Windows 得到 `/C:/...` 形式,spawn 出的子进程立即报 "Cannot find module" 死掉;而旧代码固定 sleep 500ms 后照常打印 "Server started successfully"。属于双重故障:启动失败 + 成功假象。

修复(三处):
1. daemon 脚本路径改用 `fileURLToPath(import.meta.url)`(自引用检测里同样的构造一并修正)
2. daemon 的 stderr 重定向到 `server.log`,启动失败有迹可查
3. `server start` 由「盲等 500ms」改为轮询 `/api/list` 最多 3 秒,server 没起来就明确报错,不再假装成功

## 测试

`npm test`(node:test,零新增依赖)——**89/89 通过**,其中新增:

| 层次 | 文件 | 覆盖 |
|------|------|------|
| 纯函数 | `test/test-policy.js` | token 派生(同口令同 token / 64 位 hex)、归一化、分级匹配(黑名单优先、词边界、allow-all、大小写)、自引用检测 |
| 端点 | `test/test-exec.js` | 401(无/错 token)、白名单命令返回 stdout+exitCode、黑名单 403、自引用 403、灰名单两档 policy 行为、并发上限 429、**断连杀整个进程组** |
| 集成 | `test/test-integration.js`(修复) | push/pull 端到端,全临时配置目录 |

**断连杀组测试**专门构造了会拉子进程的命令(`sh -c 'sleep 100 &'`),断开后断言 shell 和子进程 PID 全部消失——针对「孤儿进程」这个最易翻车的点。

另做了一次真实进程的端到端冒烟(临时配置目录 + 随机端口):`server start` → `enable-cli --policy block-black` → `client config` → `client enable-cli` → `exec --json`(成功返回 JSON)→ `exec "rm -rf /"`(被拦,exit=1)→ `server status`(显示 policy)→ `server stop`。

## 隔离性验证(发布安全)

最终状态实测:

- `~/.lansync`(已装 lansync 的代码 + server.json,含运行中的 server)**原封未动**
- 全局 `lansync` 命令软链完好
- 测试与冒烟全程未写真实 HOME;`~/.lansyncopt` 仅在真实使用时创建
- 新旧工具各自的 server / token / 日志完全独立

## 已知限制(后续项)

- stdout/stderr 全量内存累积后一次性返回——超长输出后续考虑流式
- 无 SSH 场景下 token 走明文 HTTP,同网段可嗅探;必要时加 HMAC 签名防重放
- 黑/灰名单是纵深防御,可被混淆/编码绕过;彻底解法是降权用户/容器沙箱(设计文档 4.5 ④)
- `sudo` 命令断连杀进程组时,若目标进程本身脱离了进程组(如某些 daemon),SIGKILL 可能伤不到——进程组 kill 覆盖绝大多数 shell 命令,极端情况留待遇到时处理
