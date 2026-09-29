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

### Windows 实战:外部 exe 的输出被"隐形控制台"吞掉(与上一个问题同源但更深)

文件捕获上线后,真机(Windows 10 19045)上仍复现:cmd **内建命令**(`echo`/`ver`/`dir`/`type`)输出可达,但 cmd 拉起的**任何外部 exe**(`node`/`where`/`cat`)stdout/stderr 全空,退出码正常。排查过程中收集到的铁证:

- 让 node 自报家门:运行的节点里 `process.stdout.isTTY === true`、`fd1 = chardev size=0` —— 子进程的 stdout 是一个**新分配的隐形控制台**,不是我们传入的捕获句柄;`stdwrite=OK` 说明输出"写成功了",只是写进了没人看的控制台
- `node script > file 2>&1`(cmd 显式重定向)同样捕不到内容 —— 重定向句柄也没传下去
- 子进程用 `fs.writeFileSync` 直接写文件**成功** —— 排除文件系统/权限因素
- 退出码始终正确传播 —— 排除进程没跑起来

根因判断:`spawn(..., {detached: true, windowsHide: true})` 在 Windows 上产生无控制台的 cmd,其控制台类子进程不再继承句柄而是各自抓到新控制台。

修复:Windows 下去掉 `detached`(POSIX 不变),断连杀进程改用 `taskkill /PID <pid> /T /F` 树杀(`killExecTree` 平台分支),断连即杀能力不受损。另注意:`type`、`dir`、`echo` 等内建命令的输出通道始终正常,可作为该类环境下的兜底手段。

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

## v1.2.0 重构(2026-09-27):全量鉴权 + 去 enable/disable 开关

> 本节**取代**上文「关键设计决策」第 2 条(token 仅作用于 `/api/exec`)与三级 policy 的旧命名。

### 动机

真实排障暴露出一串问题链:server `enable-cli` 后 `stop` 会**连 server.json 一起删掉**,重启后 cli 静默回到关闭态;client `enable-cli` 只在本地派生 token、**从不验证**,输错密码也报成功,要等 exec 时才发现 401;exec 裸抛 `fetch failed` 不带 cause(真实原因 `ENOTFOUND` 藏在 `err.cause` 里)。加上开关本身制造了「四个命令、两组状态、两端可不一致」的心智负担,决定整体简化。

### 改动

1. **全量鉴权**:所有 `/api/*`(含 `/api/list`、`/api/file`,即 pull/push)统一要求 `Authorization: Bearer <token>`,路由层一个鉴权墙搞定,`/api/auth` 端点供 `client config` 验证口令并回传 server 的 exec policy。
2. **开关清零**:`server/client enable-cli|disable-cli` 四个命令删除。`server start --policy <m>` 直接带策略(默认 `exec-forbidden`,远程命令整体关闭、文件同步不受影响),密码必输;`client config <ip:port>` = 地址校验(拦逗号当点的手滑)+ 密码 + 连 server 验证,**验证通过才落盘**,不留半截配置。
3. **policy 更名**:`allow-all`→`exec-all-allow`、`block-black`→`exec-block-black`、`block-black-gray`→`exec-block-black-gray`,新增 `exec-forbidden`(默认)。**全新 API,不做兼容**:旧名非法,`server start` 直接校验拒绝,配置里残留旧值也不映射(仅黑名单兜底)。
4. **报错带 cause**:client 所有网络请求经 `describeFetchError` 翻译,`Cannot reach <url> (ENOTFOUND): host not found ...` 形式;`checkServerReachable` 由「返回 bool」改为抛可操作错误;`withRetry` 改按错误码识别可重试。
5. **启动顺序修正**:`startServerDaemon` 改为**先写 token/policy 再 spawn**(daemon 每个请求都读配置,启动自检也带 token);启动失败清掉半截 server.json。
6. **行为边界**:重启后需重新输口令(口令即授权,不跨重启持久化);`exec-forbidden` 下 exec 一律 403(鉴权已过、策略门禁区分 401/403)。

### 测试与验证

99/99 通过(新增:exec-forbidden 403、exec-all-allow 放行、`/api/auth` 200/401、无 token 访问文件接口 401、`checkServerReachable` 对 ENOTFOUND/ECONNREFUSED 的报错文案、旧 policy 名不受兼容)。端到端冒烟(临时配置目录):start(policy) → config(对/错密码/坏地址) → pull → exec → 默认 exec-forbidden 门禁 → status,全部符合预期。

### 收口说明

本次重构工作区同时存在另一窗口的并行改动,已统一核收:package.json 版本 1.1.0→1.2.0 保留;并行窗口新增的 `LEGACY_ALIASES`(旧 policy 名兼容)按最终决策**移除**——全新 API,不兼容旧名。除此之外 src/ 无 `enable-cli`/`cliEnabled`/旧 policy 名残留。

## v1.3.0(2026-09-29):跨平台路径归一化 + 服务端空目录修剪

v1.2.0 之后两轮真实使用暴露的同步正确性问题,均为 fix 落地后随本次发版收口(版本 1.2.0→1.3.0)。

### 改动

1. **线上路径分隔符归一化**(afe2313):macOS/Windows 两侧 path separator 不同会导致远端清单匹配不上、路径错乱;改为在 HTTP 载荷层面统一用 `/`,各端落盘前再按本地语义转换。
2. **push 后服务端修剪空目录**(06caffb):push 的 DELETE 一直只走 `unlinkSync`,对目录抛 EPERM/EISDIR,本地删掉整个目录后 server 端残留空目录壳,且空壳对后续 push 永远不可见、静默积累(Windows 侧最明显)。对齐 git 语义:文件删除成功后从父目录向上逐级 `rmdir` 到 rootDir 为止,只删确认空的目录,非空/被占用即停留待下次 push;越界判断用 `..` + path.sep,不误伤 `..foo` 类目录名。

### 测试与验证

win32 语义模拟验证(嵌套修剪、root 边界、越界、跨盘符、UNC、混用分隔符、`..foo` 目录名)与集成/服务端测试全量通过(test/ 共 99+ 用例)。

## diff 清单级对账(2026-09-30)

双机实战中发现 pull/push 的输出只能间接回答「是不是同步了」(要靠 skipped 计数倒推),需要一个专门的对账命令。

### 设计与实现

1. **`lansyncopt diff [pattern] [--json]`**:清单级只读对账,一次 `/api/list` + 本地扫描,零协议改动。判定只用 hash,不复用 push/pull 的 mtime+size 快路径(避免「diff 说 modified、push 却说 skip」的自相矛盾);status 三态 `modified`/`local-only`/`server-only`,不偏向任一同步方向。
2. **返回值三层**:退出码 0/1/2(同步/有差异/错误,对齐 `git diff --quiet` 习惯)便于脚本判定;`--json` 给 agent(`{inSync, files[{path,status,local,server}], summary}`,按 path 排序可做位置对比);人类输出 git-status 风格 `M/+/-`。`--json` 时 stdout 保证只有 JSON,进度信息走 stderr 或省略。
3. **语义对齐 push/pull**:pattern 走同一套 `expandPattern`,遵守 .gitignore;server 目录不存在不报错(只读,如实报告 local-only,与 pull 的防误删拒绝不同)。
4. `src/cli.js` 的 diff 失败路径统一 exit 2(未配置/网络/鉴权),不影响现有各命令的退出码语义。

### 测试与验证

`computeDiffInventory` 单测 6 例(hash-only、三态+meta、win32 路径归一、排序稳定性)+ 集成 4 例(pull 后 exit 0 且 inSync、三态同时出现时 exit 1 且 JSON 结构断言、pattern 作用域、未配置 exit 2);test/ 全量 121 用例通过。

行级内容 diff(`--content`,单文件 LCS)列为下一步,本次未实现。

## 事故定位:测试写花真实 ~/.lansyncopt,Windows 活 server 即刻换 token(2026-09-30)

现象:Windows 端 server 全线 401、`server.json` 消失、`server stop` 报 stopped 而端口照占。历史上多次复发,本次终于完整定位。

### 根因链(四环扣死)

1. **测试缺隔离**:test-client.js(/test-config.js)直接调 `writeServerConfig`,没设 `LANSNC_CONFIG_DIR`——`~/.lansyncopt/server.json` 被覆盖为 `token: 'test-token'` + 测试进程 pid。
2. **HOME 覆盖是假隔离**:test-config.js 用 `process.env.HOME` 隔离,但 `os.homedir()` 在 Windows 走 `USERPROFILE`——**macOS 隔离生效(测试永远绿)、Windows 原样写真实配置(必炸)**。这是"两边测试结果不一致+历史反复"的直接原因。
3. **daemon 每请求重读配置**:配置被花后 8001 真实 server 立即只认 test-token,无需重启;client 所有命令(含 `node -v` 这类 exec)全部请求层 401。
4. **stop 的雪崩`:server.json` 里 pid 是早已结束的测试进程 → `process.kill` 无效但吞错 → `unlinkSync` 把(已花的)配置删掉 → 返回 "Server stopped."。用户看到的"停止不了 + 配置莫名消失"实为"杀错目标+删配置+真 daemon 完好"。

### 修复

- test-client.js / test-config.js 模块顶层 `LANSNC_CONFIG_DIR = mkdtempSync(...)`(对齐 test-server.js 既有模式);getConfigDir 默认值用例改为临时摘 env 断言后恢复。
- 经验:**任何直接读写 config 的测试文件必须在模块顶层用 LANSNC_CONFIG_DIR,HOME 覆盖在 Windows 上是无效的**。

### 遗留(见任务 #5)

stopServerDaemon 仍只信配置文件里的 pid:杀失败不校验端口、报成功、删配置。孤儿 daemon(强杀/半途 start 产生)依旧杀不掉——需在 stop 后校验 isPortInUse 并报真实占用者;status 应双重校验(pid 存活+端口占用)。

## v1.4.0(2026-09-30):server stop 端口真相 + 孤儿硬杀

承接上节事故:stopServerDaemon 只信 server.json 里的 pid,孤儿 daemon(半途 start 被端口拒绝但自己删配置、强杀断管、配置丢失脱管)永远杀不掉,且 stop 会把「杀错目标还删配置」包装成成功。本版把 stop 的语义从「按配置办事」升级为「以端口真相为准」。

### 设计

1. **stop 后核对端口**:kill 配置 pid(或无配置)之后,再查 DEFAULT_PORT(8001)是否仍被 LISTEN 占用。空闲 → 正常结束报 stopped/No server running;被占 → 展示占用者 PID+进程名,交互确认 `Kill PID n? [y/N]`,Y/-y 才硬杀,杀完复核端口并如实汇报。
2. **查占用者跨平台**:win32 `netstat -ano` 解析 LISTENING 行;POSIX `lsof -t -i:<port> -sTCP:LISTEN`。查不到(lsof 缺席)退化 null,只提示人工处理,绝不盲杀。
3. **杀进程硬保证**:win32 `taskkill /PID n /F`;POSIX SIGTERM → 让出事件循环 300ms → 仍活则 SIGKILL。**async 是必须的**:第一版用 Atomics.wait 同步睡眠,libuv 没机会收 SIGCHLD、收割僵尸,kill(pid,0) 持续命中 zombie,把已死误判为存活(SIGKILL 对 zombie 返回 0,无法补救)——本地三分实验复现后改为 await。
4. **非交互安全**:stdin 非 TTY 时确认提示直接视作 N(agent/exec 场景不悬死),并提示可加 `-y`;新占用者可能是别的程序,展示身份给用户确认,不做自动归属判断。

### 测试

getPortOwnerPid 听本地端口返回自身 pid / 空闲端口返回 null;getPidCommand 取名;killPidHard 杀真实子进程并断言 pid 消失、对已死 pid 返回 true。全量 126 用例通过。人工冒烟:非 TTY 下 stop 正确识别 8001 占用并保持不动,-y 一击kill 且端口清空。

### 部署注意

版本 1.3.0→1.4.0。setup.sh/npm 链接安装的副本不会随仓库同步自动更新——**代码 push 到机器后需要重跑安装才能让该机的 `lansyncopt` 命令携带新功能**,正在运行的 server daemonρέ也需重启。

### 补遗(v1.4.1,同日)

1. **exec 输出 UTF-8**:win32 cmd 内建命令输出跟随 OEM codepage(中文系统 GBK),经管道回传按 UTF-8 解码成乱码(taskkill 的「成功:」变天书)。server 端执行前 `chcp 65001 >nul` 统一切 UTF-8,所有子命令受益。
2. **测试 daemon 死透等待**:win32 下 daemon 的 cwd 锁着 temp 目录,stop 后立刻 rmSync 必撞 EPERM(强杀后内核关句柄需要一瞬;marauding maxRetries 只能 3s 兜底)。afterEach 改为轮询 daemon pid 直到消失(至多 5s)再删;并定位到今日历次被杀测试遗留的 8 个孤儿 daemon(人工 taskkill 清理)。
3. **提交身份约定**:远程仓库的提交作者必须是仓库所在机器的 git 身份(Windows: victorygod <htli0719@outlook.com>),git log 中不得出现lanesync另一侧的身份;跨机搬运行内改动后统一以落盘机器身份提交,Mac 侧提交仅作为本机备份。
