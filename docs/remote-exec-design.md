# lansync 远程命令执行(Remote Exec)设计方案

## 一、背景与目标

当前 lansync 只支持文件同步:client 通过 HTTP 调用 server 的 `/api/list`、`/api/file` 接口,实现 `push`/`pull`。

本方案为 server 增加一个**远程命令执行**能力:client 可以把一条 CLI 命令发给 server,server 在**自己的 rootDir 内**执行并把 stdout/stderr/退出码返回给 client。

**核心使用场景**:agent(或脚本)在 client 机器上调用 `lansyncopt exec "<命令>"`,让命令在 server 机器上执行——例如在同步目录里跑 `git pull`、`npm install`、`npm test`,然后 agent 自己管理超时。

## 二、安全模型定位

**这不是「给文件同步工具加个小功能」,而是「做一个局域网内的、无 SSH 的远程 shell」。**

选择了「任意 shell 命令」之后,一个必须认清的事实是:server 端的**工作目录约束、路径逃逸防护、命令合法性校验全部失效**——因为 `cd /etc; ...` 本身就是一条合法命令。安全不再依赖路径校验,而完全依赖以下四件事:

| 安全支柱 | 说明 |
|---------|------|
| **鉴权** | 口令 → token,无 token 拒绝执行 |
| **分级管控** | 黑名单 + 灰名单 + `--policy`,作为纵深防御(见第四节) |
| **审计** | 每次执行记录时间、来源 IP、命令、退出码、耗时 |
| **可撤销** | disable 清 token,并发上限防资源耗尽 |

> 一句话:谁能提供正确口令,谁就拥有 server 机器的执行权。因此口令强度、token 传输、审计、可撤销的质量,决定了这个功能是「有用的远程执行」还是「给全网发后门」。

## 三、鉴权设计(口令 → token)

口令只用于 enable 时的派生,**绝不作为长期凭证传输或落盘**。

采用**确定性派生**,双方输入相同口令即可算出相同 token,无需额外网络握手:

```
token = HMAC-SHA256(key = 口令, msg = "lansync-cli-v1")
```

- server 端 `enable-cli` 输入口令 → 派生 token 存 `server.json`
- client 端 `enable-cli` 输入相同口令 → 派生相同 token 存 `client.json`
- 后续每次调用 `lansync exec` 自动携带 token
- **口令本身不落盘,只存派生的 token**
- 换口令 = 双方重新 enable

口令输入方式(二选一,均支持):

1. **交互式**:readline 隐藏回显输入
2. **环境变量** `LANSNC_PASSWORD`(agent 场景更适合,避免交互阻塞)

### 传输与收紧

- token 放 `Authorization: Bearer <token>` header,**绝不放 URL**(URL 会进日志、被代理记录)
- `/api/exec` 强制校验 token,无效返回 `401`
- **token 仅作用于 `/api/exec`**:`/api/list`、`/api/file`(即 `pull`/`push`)不校验 token,行为与现有版本完全一致、向后兼容
- 收紧 CORS:文件接口维持现状,`/api/exec` 单独作为高危面处理

## 四、命令分级管控(黑名单 + 灰名单)

「任意 shell 命令」模式下,单纯黑名单有两个痛点:**灾难性命令**必须拦,但**高频、功能强大的半安全命令**(`sudo`、`kill`、`git reset --hard`、`docker prune`、卸载类)如果也一刀切进黑名单,会严重影响 agent 日常操作。

因此采用**三级分级**,由 server 在 `enable-cli` 时通过 `--policy` 参数选择:

| 层级 | 标准 | 例子 | 拦截时机 |
|------|------|------|---------|
| **黑名单** | 灾难性 / 不可逆 / 攻击性 | `rm -rf /`、`mkfs`、`format`、`shutdown`、fork 炸弹、LOLBin 持久化、杀 server 自身 | `block-black`、`block-black-gray` 都拦 |
| **灰名单** | 高频、功能强大、半安全(可能误伤/局部不可逆,但非灾难) | `sudo`、`kill`/`pkill`、`rm`(定向)、`git reset --hard`、`git push --force`、`systemctl restart`、`docker system prune`、`npm uninstall`/`publish` | 仅 `block-black-gray` 拦 |
| **其余(隐式白名单)** | 低风险 / 可逆 / 只读 | `git pull`、`npm install`、`npm test`、`ls`、`cat` | 始终允许 |

`enable-cli` 的 `--policy` 取值:

| 取值 | 含义 | 适用场景 |
|------|------|---------|
| `allow-all` | 全允许,黑灰都不拦 | 完全可信的单机 / 实验环境 |
| `block-black` | **屏蔽黑**,灰名单放行(默认) | 常规 agent 场景:允许高频命令,拦灾难性破坏 |
| `block-black-gray` | 屏蔽黑灰,黑+灰都拦 | 最严格,只放行低风险命令 |

### 4.1 定位与局限

- 黑/灰名单**不能替代**鉴权:有 token 的人本来就是受信主体
- 黑/灰名单**可以被绕过**(别名、编码、`\rm`、`$(...)` 拼接等),这是所有黑名单的固有限制
- 它真正的价值是:**防止受信主体的误操作**(agent 拼错命令、脚本 bug 传出 `rm -rf`)和**阻止最粗野的破坏**
- 灰名单是**弹性层**:让「高频但半安全」的命令在默认模式可用,又能在严格模式下收紧

### 4.2 匹配策略

对整条命令字符串(及 token 化后的各段)做匹配,命中即拒绝并返回 `403`:

| 层级 | 说明 |
|------|------|
| **精确匹配** | 命令名/路径精确等于黑名单项 |
| **前缀匹配** | 命令以黑名单项开头(如 `shutdown`, `reboot`) |
| **危险组合** | 检测高危命令 + 高危参数的组合(如 `rm -rf /`) |

跨平台匹配注意:

- **Windows 命令不区分大小写**(cmd.exe 与 PowerShell 均如此),匹配前需将命令归一化为小写,否则 `DEL /S /Q` 可绕过 `del /s /q`
- **路径分隔符归一化**:Windows 用 `\`,建议匹配前将命令里的 `\` 与 `/` 统一,避免用 `\` 变体绕过(黑名单条目里 `C:\\` 即实际字符串 `C:\`)

### 4.3 默认分级清单

**匹配顺序:黑名单优先于灰名单。** 命令先与黑名单比对,命中即拦(除非 `allow-all`);未命中再与灰名单比对,命中则在 `block-black-gray` 模式下拦。因此「全盘/灾难」的精确定位(如 `rm -rf /`、`find / -delete`、`sudo su`)放黑名单,泛化形式(如 `rm`、`sudo`)放灰名单,靠顺序区分。

**① 默认黑名单(灾难性,除 `allow-all` 外都拦):**

```js
const DEFAULT_COMMAND_BLACKLIST = [
  // ===== Unix / Linux / macOS =====
  // 磁盘/文件破坏(对根或全盘)
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -fr /',
  'dd',                                  // 裸设备读写(if=/dev/zero of=/dev/sda 等)
  'mkfs',
  'mkfs.ext4',
  'mkfs.xfs',
  'fdisk',
  'parted',
  'wipefs',                              // 清除文件系统签名
  'find / -delete',                      // 批量删除变体
  'find / -exec rm',
  'chmod -R 777 /',                      // 破坏全盘权限
  'chmod 000 /',
  'diskutil eraseDisk',                  // macOS 抹盘
  'diskutil eraseVolume',
  'diskutil zeroDisk',
  // 关机/重启
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  // 关机/重启(systemctl 变体)与关闭安全边界
  'systemctl poweroff',
  'systemctl reboot',
  'systemctl halt',
  'iptables -F',                         // 清空防火墙
  'ufw disable',
  // fork 炸弹
  ':(){ :|:& };:',
  // 清空关键日志/历史
  'history -c',
  '> /dev/sda',
  // 提权逃逸(可配置开启)
  'sudo su',
  'sudo -i',
  'su -',
  'su root',
  'sudo -s',
  'sudo bash',
  'doas',
  'pkexec',

  // ===== Windows (cmd.exe) =====
  // 磁盘/文件破坏
  'format',                              // 格式化磁盘
  'del /s /q C:\\',                      // 删除 C 盘
  'rd /s /q C:\\',                       // 删除 C 盘目录
  'diskpart',                            // 磁盘管理(可 clean 整盘)
  'fsutil',                              // 文件系统工具(可 dismount/删卷)
  'takeown',                             // 夺取文件所有权
  'icacls',                              // 修改 ACL(可 deny 锁死)
  'cacls',                               // 旧版 icacls
  // 注销
  'logoff',
  // 系统配置破坏
  'bcdedit',                             // 修改启动配置
  'reg delete',                          // 删除注册表
  'reg add',                             // 修改注册表
  'reg import',                          // 导入注册表
  'regsvr32',                            // 注册/执行 DLL
  'sc delete',                           // 删除系统服务
  'net user',                            // 用户管理(建用户/改密码)
  'net localgroup',                      // 改组(可提权到 admin)
  // 提权
  'runas',                               // 提权运行
  // 下载/执行/持久化(LOLBin,示例性列举,列不完)
  'certutil -urlcache',                  // 下载文件
  'bitsadmin',                           // 下载文件
  'mshta',                               // 执行 HTML 应用
  'rundll32',                            // 执行 DLL
  'schtasks',                            // 计划任务(持久化)
  'powershell -EncodedCommand',          // 编码命令(绕过检测)

  // ===== Windows (PowerShell) =====
  'Remove-Item C:\\ -Recurse -Force',
  'Format-Volume',                       // 格式化卷
  'Clear-Disk',                          // 清空磁盘
  'Stop-Computer',                       // 关机
  'Restart-Computer',                    // 重启
  'New-LocalUser',                       // 建用户
  'Add-LocalGroupMember',                // 加到管理员组(提权)
  'Set-NetFirewallProfile',              // 关防火墙
  'Disable-ComputerRestore',             // 关系统还原
  'Enable-PSRemoting',                   // 开远程(持久化)
  'Invoke-Expression',                   // 执行(编码绕过)

  // ===== Server 自身保护(防误杀 lansync server / node 全家) =====
  'killall node',                        // 杀所有 node 进程(含 server)
  'pkill -f lansync',
  'pkill -f server.js',
  'taskkill /f /im node.exe',            // Windows:杀所有 node 进程
  'wmic process where name="node.exe" delete',
  'Stop-Process -Name node',             // PowerShell
];
```

**② 默认灰名单(高频半安全,仅 `block-black-gray` 模式拦):**

```js
const DEFAULT_COMMAND_GRAYLIST = [
  // ===== Unix / Linux / macOS =====
  // 提权(裸 sudo;黑名单已精确拦 sudo su / sudo -i / sudo -s / sudo bash)
  'sudo',
  // 进程控制(杀自己起的卡死进程;黑名单已精确拦 node 全家 / lansync)
  'kill',
  'pkill',
  'killall',
  // 定向删除/改权限/覆写(黑名单已精确拦全盘)
  'rm',
  'chmod',
  'chown',
  'shred',
  'find -delete',
  'find -exec rm',
  // 破坏性 git 操作
  'git reset --hard',
  'git clean',
  'git push --force',
  'git push -f',
  // 服务控制(可逆,但影响面大)
  'systemctl stop',
  'systemctl disable',
  'systemctl mask',
  'systemctl restart',
  'service stop',
  'service restart',
  // 卸载 / 发布(高频,但可能误删依赖)
  'npm uninstall',
  'npm publish',
  'npm unpublish',
  'pip uninstall',
  'brew uninstall',
  'apt remove',
  'apt purge',
  'yum remove',
  // 容器/镜像清理(误删需重建)
  'docker rm',
  'docker rmi',
  'docker system prune',
  'docker volume rm',
  'docker stop',
  'docker kill',

  // ===== Windows (cmd.exe) =====
  'del',                                 // 定向删除(黑名单已精确拦 C:\)
  'del /f /s /q',
  'rd',
  'rd /s /q',
  'taskkill',                            // 定向杀进程(黑名单已精确拦 node.exe)
  'net stop',                            // 停服务(可逆)

  // ===== Windows (PowerShell) =====
  'Remove-Item',                         // 定向删除(黑名单已精确拦 C:\)
  'Stop-Process',                        // 定向杀进程
  'Stop-Service',
  'Restart-Service',
];
```

> **黑名单的边界**:下载并执行类(LOLBin)是军备竞赛,列不完;`rm`/`del` 的混淆变体(`rm -r -f`、`$(...)` 拼接、编码)同理。这一层只兜「明显/意外的破坏」,真正的边界靠鉴权 + 审计 + 后续沙箱隔离(见 4.5 ④)。

> **`sudo` 分级说明**:`sudo` 在灰名单(默认 `block-black` 模式放行),但 `sudo su`/`sudo -i`/`sudo -s`/`sudo bash` 这类「拿到交互 shell」仍在黑名单。灰名单里的 `rm`/`sudo`/`kill`/`del` 是泛化前缀,靠「黑名单优先」与上面对应的全盘/全家精确项区分。

### 4.4 可配置与 policy

黑/灰名单均支持在 server 端配置扩展/覆盖,按来源合并:内置默认项 + 用户配置项 + 环境变量(`LANSNC_BLACKLIST` / `LANSNC_GRAYLIST`,逗号分隔)。

```jsonc
// server.json
{
  "policy": "block-black",        // allow-all | block-black | block-black-gray
  "commandBlacklist": [
    "rm -rf /",
    "shutdown",
    "reboot",
    "format",
    "rd /s /q C:\\",
    // 用户自定义追加项
  ],
  "commandGraylist": [
    "sudo",
    "kill",
    "rm",
    "git reset --hard",
    "docker system prune",
    // 用户自定义追加项
  ]
}
```

`policy` 由 `enable-cli --policy` 写入,也可直接改配置后重启生效。

### 4.5 Server 本进程与自身文件保护

黑名单只防「破坏宿主 OS」,但有一个更致命的缺口:**远程命令与 lansync server 跑在同一 OS 用户、同一台机器**,它完全可以:

- `kill <server_pid>` / `pkill -f server.js` 杀掉 server 进程(造成 DoS,且切断审计)
- `rm -rf ~/.lansyncopt` 删掉 server 代码、`server.json`、token、日志
- 读 `~/.lansyncopt/server.json` 窃取 token,或覆写它把所有人锁死
- `taskkill /f /im node.exe` 把整台机器的 node 全部杀掉

因此需要**独立于普通黑名单的自保护**,分两层:

**① 静态黑名单**:拦截「杀 node 全家 / 杀 lansync」这类显式针对(见 4.3 末尾)。注意**不**拦裸 `kill` / `pkill` / `taskkill`,因为 agent 可能需要杀掉自己起的、卡住的 dev 进程——裸 kill 交给下面的动态检测兜底。

**② 动态自引用检测(关键)**:server 执行前,把命令字符串与**自己的运行时标识**比对,命中即拒绝并审计。这些标识是普通黑名单无法静态覆盖的(比如 PID 每次启动都变):

| 检测项 | 来源 | 拦截目的 |
|--------|------|---------|
| server 自身 PID | `process.pid` | 防 `kill <pid>`、`kill -9 <pid>` 直接杀 server |
| `~/.lansyncopt` 绝对路径 | `getConfigDir()` | 防删/读/写 config、token、代码、日志 |
| server 代码路径 | `server.js` 绝对路径 | 防覆写 server 代码植入后门 |

> **实现修正**:工具名(`lansync`/`lansyncopt`)**不**参与自引用检测——裸子串匹配会误拦任何含该词的路径(如同步目录名恰好含 "lansync")。「按名杀 server」(`pkill -f lansync`、`taskkill /f /im node.exe` 等)由黑名单精确项覆盖(见 4.3 末尾)。

检测时做**大小写归一化 + 路径分隔符归一化**(同 4.2),防止 `~/.lansyncopt` 写成 `~/\.lansyncopt` 或 `C:\Users\x\.lansyncopt` 绕过。

**③ 自身文件权限加固(纵深)**:`~/.lansyncopt` 目录权限收紧(Unix `chmod 700`),虽不能阻止同用户命令,但能降低被非 lansync 进程误碰的概率。

**④ 进阶隔离(后续可扩展)**:真正的保护是把 exec 命令放到**降权用户 / 容器 / 沙箱**里跑,让它从根本上碰不到 server 进程与文件。这是最彻底的方案,但跨平台成本高,列为后续项,不在本方案首版实现。

## 五、执行模型

### 5.1 同步返回 + 断连即杀

- **短命令同步返回**:请求阻塞到命令结束,一次性返回 `{ exitCode, stdout, stderr, durationMs }`
- **不设 server 端固定超时**(命令可无限运行,交给 client/agent 决定何时停)
- **断连即杀**:client 侧(agent 超时后 kill、网络断开、Ctrl-C)一旦断开连接,server 立即终止远端进程

这是本方案最贴合 agent 场景的设计:agent 自己管 timeout,超时 kill 掉 client 调用,server 同步终止远端命令。

### 5.2 断连检测与进程组 kill

**这是整个功能最容易出 bug 的地方,实现必须覆盖:**

```js
// 监听请求断开
req.on('aborted', () => cleanup());
res.on('close', () => cleanup());

// spawn 时建立独立进程组
const child = spawn(command, {
  shell: true,        // 任意 shell 命令
  detached: true,     // 独立进程组
  cwd: rootDir
});

// kill 整组(负号 PID = 杀整个进程组),防止 shell 子进程变孤儿
function cleanup() {
  try {
    process.kill(-child.pid, 'SIGTERM');
    // 宽限期后升级为 SIGKILL
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 2000);
  } catch {}
}
```

**必须写测试验证**:起一个 `sleep 100` 作为远端命令,断开连接后确认 `ps` 里不再有该进程(及 `shell: true` 拉起的子进程)。

## 六、并行与并发控制

每个 `/api/exec` 请求独立 spawn,天然支持并行。但「任意命令 + 无上限并行」= fork 炸弹风险,必须限制:

- server 侧配置 `maxConcurrent`(默认 4)
- 超出上限:排队等待,或返回 `429 Too Many Requests`(推荐后者,语义清晰,agent 可重试)

```jsonc
// server.json
{ "maxConcurrent": 4 }
```

## 七、API 设计

```
POST /api/exec
  Header: Authorization: Bearer <token>
  Body:   {
            "command": "git pull && npm test",
            "cwd": "src"          // 可选,相对 rootDir,默认 = rootDir
          }

  成功响应 (200):
  { "exitCode": 0, "stdout": "...", "stderr": "...", "durationMs": 1200 }

  错误响应:
  401 无/错 token          { "error": "Unauthorized" }
  403 命中黑/灰名单        { "error": "Command blocked (blacklist/graylist): rm" }
  429 并发超限            { "error": "Too many concurrent commands" }
  400 缺少 command         { "error": "Missing command" }
```

要点:

- `command` 是完整的 shell 命令字符串,由 client 端提供,server 用 `spawn(command, { shell: true })` 执行
- `cwd` 是**尽力而为**的约束:在「任意命令」模式下 `cd` 可逃逸,因此它只是默认工作目录,不是安全边界
- stdout/stderr 在内存中累积后一次性返回(短命令场景足够;超长输出后续可扩展为流式)

## 八、CLI 设计(完整指令集)

本分支命令统一为 `lansyncopt`(见第十四节改名说明)。完整指令集如下:

**Server 管理:**

```bash
lansyncopt server start                 # 启动文件同步服务(默认端口 8001)
lansyncopt server stop                  # 停止服务
lansyncopt server status                # 查看服务状态(含 cliEnabled / policy)
```

**Client 配置:**

```bash
lansyncopt client config <ip:port>      # 配置服务器地址(同时记录当前工作目录)
lansyncopt client status                # 查看客户端配置(含 token 状态)
```

**文件同步:**

```bash
lansyncopt pull [pattern] [--no-delete] # 从 server 拉取文件
lansyncopt push [pattern] [--no-delete] # 推送文件到 server
```

**远程命令执行(本分支新增):**

```bash
lansyncopt server enable-cli --policy <mode>  # 开启远程命令:输口令 + 选策略
lansyncopt server disable-cli                 # 关闭远程命令
lansyncopt client enable-cli                  # 客户端输同口令
lansyncopt client disable-cli                 # 客户端撤销
lansyncopt exec [--json] "<命令>"             # 执行远程命令(命令整体引号包裹)
```

**全局:**

```bash
lansyncopt --version | -v              # 版本号
lansyncopt --help | -h                 # 帮助
```

`--policy` 取值:`allow-all`(全允许)/ `block-black`(屏蔽黑,默认)/ `block-black-gray`(屏蔽黑灰)。

> `policy` 只由 **server 端**决定(client 无法覆盖)。server 判定拦截后 client 只收到 403,无法通过改 client 配置绕过。

### 8.1 `exec` 行为

- 读取 `client.json` 的 token 与 serverUrl
- 携带 token 调 `/api/exec`
- 实时打印 stdout/stderr(或结束后一次性打印,取决于实现)
- 退出码透传给调用方(agent 据此判断成功/失败)
- client 进程被 kill(agent 超时)→ HTTP 连接断开 → server 终止远端命令,闭环

### 8.2 Agent 调用约定

agent(或脚本)通过 `lansyncopt exec` 调用,接口契约如下:

| 项 | 约定 |
|----|------|
| 命令形态 | `lansyncopt exec [--json] "<命令>"`——`--json` 在前,命令**必须整体引号包裹**(否则 `&&`/`|`/`>`/空格会被 agent 自身的 shell 截断) |
| 结果判定 | 退出码 = 远端命令退出码(`0` 成功);非 0 时结合 stderr 判断 |
| 机器可读输出 | 加 `--json`,stdout 输出 `/api/exec` 原样 JSON:`{ "exitCode": 0, "stdout": "...", "stderr": "...", "durationMs": 1200 }`,避免解析人肉文本 |
| 拦截信号 | 命中黑/灰名单 → 非 0 退出 + stderr 含 `blocked`;无/错 token → `401` |
| 超时 | agent 自己 kill `lansyncopt exec` 进程即可;连接断开 server 同步杀远端进程 |

**前置检查**:调用前先 `lansyncopt client status` 确认已 `enable-cli`(有 token);否则 `exec` 直接报未配置。

## 九、配置变更

```jsonc
// server.json 增加
{
  "cliEnabled": true,
  "token": "<派生的token>",
  "policy": "block-black",           // allow-all | block-black | block-black-gray
  "maxConcurrent": 4,
  "commandBlacklist": ["rm -rf /", "shutdown", "reboot"],
  "commandGraylist": ["sudo", "kill", "rm", "git reset --hard"]
}

// client.json 增加
{
  "token": "<相同token>"
}
```

## 十、审计日志

任意命令执行必须落审计日志,追加到 `~/.lansyncopt/server.log`(或独立 `exec.log`):

```
[2026-09-23T10:30:00.000Z] EXEC ip=192.168.1.50 command="git pull" cwd="root" exitCode=0 durationMs=1200
[2026-09-23T10:31:00.000Z] BLOCKED ip=192.168.1.50 command="rm -rf /" reason=blacklist
[2026-09-23T10:31:30.000Z] BLOCKED ip=192.168.1.50 command="docker system prune" reason=graylist(policy=block-black-gray)
[2026-09-23T10:32:00.000Z] DENIED ip=192.168.1.50 reason=no_token
```

每条记录包含:时间、来源 IP、命令、cwd、退出码、耗时(命中黑名单/无 token 的也记录)。

## 十一、实现要点清单

1. **鉴权中间件**:统一校验 `Authorization: Bearer <token>`,与 `~/.lansyncopt/server.json` 中的 token 比对
2. **分级匹配**:黑名单优先 → 灰名单,按 `policy` 决定是否拦截灰名单;命中返回 403
3. **动态自引用检测**:命令与自身 PID / `~/.lansyncopt` / 代码路径比对,命中拒绝并审计
4. **断连 kill**:`req.on('aborted')` + `res.on('close')` → 进程组 kill(SIGTERM → 2s → SIGKILL)
5. **并发控制**:`maxConcurrent` 上限,超出返回 429
6. **审计日志**:成功/拒绝/拦截三类事件全部落盘
7. **enable/disable**:派生 token、清 token、状态查询
8. **隐藏口令输入**:readline 不回显 + 支持 `LANSNC_PASSWORD` 环境变量

## 十二、涉及改动文件

| 文件 | 改动 |
|------|------|
| `src/server.js` | 新增 `/api/exec`、token 校验中间件、黑/灰名单分级 + policy、断连 kill、并发上限、审计日志、enable/disable-cli |
| `src/client.js` | 新增 `exec()`、enable/disable 逻辑 |
| `src/cli.js` | 新增 `exec`、`server/client enable-cli --policy`、`disable-cli` 命令 |
| `src/config.js` | token、policy、黑/灰名单、maxConcurrent 读写 |
| `DESIGN.md` | 更新设计文档 |
| `README.md` | 更新用法说明 |

## 十三、风险与限制

| 风险 | 缓解 |
|------|------|
| token 明文 HTTP 传输,同网段可嗅探 | 局域网可信假设;必要时后续加 HMAC 签名防重放 |
| 黑/灰名单可被绕过(别名/编码/拼接) | 分级名单只是纵深防御,核心安全靠鉴权 + 审计 + 信任 |
| 任意命令 = 拥有 server 机器 | 对标「局域网远程 shell」,口令强度与可撤销是关键 |
| server 被自身命令杀掉 / 文件被覆写 | 动态自引用检测 + 静态自保护黑名单 + 进阶降权隔离 |
| fork 炸弹 / 资源耗尽 | `maxConcurrent` 上限 + 断连即杀 |
| 孤儿进程(断连后残留) | 进程组 kill,必须测试覆盖 |

## 十四、临时改名发布(避免覆盖已装 lansync)

本分支为并行开发/灰度,临时以 `lansyncopt` 之名发布,要求**不覆盖**已装好的 `lansync` 命令及其配置目录。需改动的硬编码位置:

| 位置 | 现状 | 改为 | 目的 |
|------|------|------|------|
| `package.json` | `"name": "lansync"`、`"bin": { "lansync": ... }` | `"name": "lansyncopt"`、`"bin": { "lansyncopt": ... }` | 全局命令名不冲突 |
| `src/config.js` | `getConfigDir()` → `~/.lansync` | → `~/.lansyncopt` | server.json / client.json / token / 日志不覆盖旧 lansync |
| `src/cli.js` | 版本号与 help 文案 `lansync` | → `lansyncopt` | 展示名一致(纯文案) |
| `setup.sh` | `INSTALL_DIR=~/.lansync`、`npm link`、`npm unlink -g lansync` | `~/.lansyncopt`、unlink `lansyncopt` | 安装目录与卸载互不影响 |
| `README.md` | 命令名/安装路径 | → `lansyncopt` | 文档一致 |

**结果**:

- 旧 `lansync` 命令 + `~/.lansync` 目录**原样保留**,不受影响
- 新 `lansyncopt` 命令 + `~/.lansyncopt` 目录独立运行
- 两者各自维护自己的 token / 配置 / server 状态,互不可见

> **保持共享的项**(不与旧 lansync 冲突,无需改名):token 派生盐 `"lansync-cli-v1"`、环境变量 `LANSNC_PASSWORD` / `LANSNC_BLACKLIST` / `LANSNC_GRAYLIST`——旧 lansync 尚未使用这些,不冲突。

> **临时性**:仅本 `feature/remote-exec` 分支改名。功能验收通过、决定合并回 `main` 后,再把名称恢复为 `lansync`(建议后续在 `package.json` 用单一字段统一管理名称,避免散落多处硬编码)。
