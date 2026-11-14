# DeepSeek 代码审查记录（2026-11-14）

> **免责声明：本文档由 DeepSeek 模型生成，审查过程可能出错。**
> 文中的每条结论都来自静态阅读和本文附带的复现脚本/命令输出，但审查没有覆盖所有平台（尤其没有真实的 Windows 环境），也没有对并发、超大规模目录、异常网络等场景做穷尽测试。请以代码和实际复现为准；若与后续事实冲突，以事实为准。本文档不修改任何代码。

- **审查对象**：`codex/lansyncopt-scope` 分支，HEAD `14d92d4`（含未提交工作区改动）
- **审查环境**：macOS，Node.js v22.22.0
- **审查方式**：只读阅读 `src/`、`test/`、文档，配合临时目录中的最小复现脚本（脚本见文末附录）
- **基线结果**：`npm test` 全部通过（142 tests / 49 suites / 0 fail），因此以下问题都属于**现有测试未覆盖**的范围

## 结论摘要

| # | 问题 | 性质 | 严重度 | 是否已复现 |
|---|------|------|--------|-----------|
| 1 | `exec` 不再接受未加引号的多词命令 | 行为回归 | 中 | 是（真实 CLI） |
| 2 | 扫描器 fail-loud 后，单文件瞬态错误会中止整次同步 | 设计权衡风险 | 中 | 是（调用函数） |
| 3 | 客户端 `.gitignore` 基准目录与扫描目录不一致 | 同步正确性缺陷（既有） | 中高 | 是（调用函数） |
| 4 | `path` / `scope` / `X-Path` 被二次 URL 解码，含 `%` 的文件名不可用 | 正确性缺陷（既有，新增 `scope` 继承） | 中 | 是（真实 HTTP） |
| 5 | `sanitizePath` 不解析符号链接，可读写/删除同步根之外的文件 | 安全缺陷（既有） | 高 | 是（真实 HTTP） |
| 6 | Windows 服务端把反斜杠相对路径直接交给忽略规则匹配 | 跨平台正确性缺陷（既有） | 中 | 是（函数级模拟） |
| 7 | 文档残留不一致 | 文档问题 | 低 | 是（grep） |
| 8 | 死代码、Node 版本声明、测试命名、未跟踪的测试文件 | 维护性问题 | 低 | 是 |
| 9 | `--json` / 大批量输出在 `process.exit()` 时被截断到 64 KiB | 功能缺陷（既有） | 高（agent/脚本消费场景） | 是（真实 CLI + HTTP） |

其中 **#5（symlink 越界）** 和 **#9（`--json` 截断）** 的影响最大；#9 不涉及数据损坏，但会让 agent 拿到不完整 JSON，且在只看退出码时不会被发现。

---

## 1. `exec` 不再接受未加引号的多词命令（行为回归）

**位置**：`src/cli.js:55-57`、`src/cli.js:520-537`

**问题**：参数解析重写后，`exec` 的位置参数被限制为恰好 1 个，且下游只取 `patterns[0]`。旧实现是 `subArgs.filter(a => a !== '--json').join(' ')`，因此未加引号的多词命令以前可用，现在直接失败。

**证据**（真实 CLI 调用）：

```text
$ node bin/lansync.js exec git status
Error: Invalid arguments for exec. See lansyncopt exec --help
exit=1

$ node bin/lansync.js exec ls -la
Error: Unknown option '-l'. To specify a positional argument starting with a '-', place it at the end of the command after '--', ...
exit=1

$ node bin/lansync.js exec "git status"
Client not configured. Run: lansyncopt client config <ip:port>   # 参数层通过，进入业务逻辑
```

旧的 join 行为可由历史版本确认：

```text
$ git show e77db17^:src/cli.js | grep -n "const command"
    const command = subArgs.filter(a => a !== '--json').join(' ');
```

**影响**：脚本或 agent 里常见的 `lansyncopt exec git pull`、`lansyncopt exec ls -la` 会从“可用”变为“参数错误”。README 示例都带引号，所以文档层面不算违约，但这是实打实的兼容性回退。

**建议**：对 `exec` 放宽为可变位置参数并在命令拼接时 join，或至少在错误信息中明确提示“命令必须整体加引号”。若要保留严格校验，建议在 README/CHANGELOG 中标注破坏性变更。

---

## 2. 扫描器 fail-loud 后，单文件瞬态错误会中止整次同步（设计权衡）

**位置**：`src/client.js:279`、`src/client.js:292-294`、`src/server.js:173`

**问题**：近期改动移除了扫描时 `readdirSync` / `statSync` / `readFileSync` 的逐个 try/catch，任何一项失败都会向上抛出。安全动机是合理的（旧逻辑静默跳过文件，会让对端把该文件当“多余”删除），但代价是失败域从“跳过单个文件”扩大到“整次同步中止”。

**证据**：

```text
scan unreadable -> throws: Cannot read locked/file
```

对应新测试 `test/test-sync-failures.js:16-25` 也把该行为固定了下来：

```js
it('both scanners propagate directory and file read errors', ...)
```

此外 `fetchFileList`（`src/client.js:127-144`）没有接入 `withRetry`，只有单文件传输有重试。服务端 `/api/list` 在扫描中途遇到文件消失会返回 500，客户端不会自动重试。

**影响**：活跃工作区里构建产物被并发改写时，一个瞬态 `ENOENT` 就可能让 push/pull/diff 整体失败。数据安全上更保守，但可用性下降。

**建议**：保留 fail-loud 的安全语义，同时给 `/api/list` 增加一次网络/5xx 重试；或把不可读文件作为显式失败项随清单返回，而不是整棵树中止。

---

## 3. 客户端 `.gitignore` 基准目录与扫描目录不一致（同步正确性缺陷）

**位置**：`src/client.js:507-521`（从 `workDir` 读取规则）、`src/client.js:284`（相对路径以 `dir` 为基准）、调用点 `src/client.js:449`、`587`、`653`

**问题**：忽略规则来自 `workDir`，但 `scanLocalFiles` 的 `dir` 参数是 `currentDir`（可能是子目录），相对路径因此以 `currentDir` 为基准。gitignore 模式不会随当前目录平移，导致在子目录执行同步时规则失效。服务端始终以 `rootDir` 为基准（`src/server.js:431`），两端过滤结果会分叉。

**证据**（模拟 `workDir` 根目录规则 `src/generated/`，分别在根目录和 `src/` 下扫描）：

```text
scan(workDir)    -> [ '.gitignore' ]          # src/generated/out.js 被忽略，正确
scan(workDir/src)-> [ 'generated/out.js' ]    # 同一规则失效，文件被纳入同步
```

**影响**：`cd src && lansyncopt push/pull/diff` 时，根目录 `.gitignore` 中带路径前缀的规则不生效。push 会把本应忽略的文件上传；pull 会下载它们；更危险的是 push 可能把对端本应保留的忽略文件视为“本地没有”而删除。这是既有问题，但多路径/子目录同步成为正式能力后被放大。

**建议**：统一忽略规则的评估基准。两种可行做法：始终以 `workDir` 为基准计算相对路径后再匹配；或在扫描子目录时，把 `workDir → currentDir` 的前缀拼到规则上。

---

## 4. `path` / `scope` / `X-Path` 被二次 URL 解码，含 `%` 的文件名不可用

**位置**：`src/server.js:116`（`sanitizePath` 内部 `decodeURIComponent`）、`src/server.js:438-445`（GET 文件）、`src/server.js:467` + `474`（POST 文件：先解码 `X-Path`，再交给 `sanitizePath` 二次解码）、`src/server.js:517-518`（DELETE scope 与 path）

**问题**：`sanitizePath` 内部会做一次 `decodeURIComponent`，而所有调用方传入的已经是解码过的值：查询参数经 `URLSearchParams.get()` 解码，`X-Path` 请求头经 `decodeURIComponent` 解码。文件名含 `%` 时第二次解码会抛 `URIError`，被当作非法路径拒绝。新增的删除 `scope` 参数同样走这条路径。

> 审查中我最初以为 `X-Path` 只解码一次、不受影响；实测 POST 同样返回 403，说明三个入口都受影响。

**证据**（真实 HTTP）：

```text
sanitizePath("100%.txt") = null
GET  /api/file?path=100%25.txt              -> 403 {"error":"Invalid path","path":"100%.txt"}
POST /api/file  (X-Path: 100%25.txt)        -> 403, 文件未创建
DELETE /api/file?path=100%25.txt&scope=    -> 403 {"error":"Invalid path"}, 文件未被删除
```

**影响**：README 第 175 行宣称“Full support for Chinese and special characters in filenames”，但含 `%` 的文件无法读取/上传/删除。对合法文件来说这是功能性缺陷，不是单纯的安全拦截。

**建议**：`sanitizePath` 只做路径解析，不再调用 `decodeURIComponent`；由调用方明确传入已解码值。修复后需同时覆盖 query 参数、`X-Path` 请求头和 `scope` 参数三类入口。

---

## 5. `sanitizePath` 不解析符号链接，可读写/删除同步根之外的文件（安全缺陷）

**位置**：`src/server.js:111-145`；配合 `src/server.js:459-460`（读）、`src/server.js:490`（写）、`src/server.js:524`（删）

**问题**：`sanitizePath` 只做词法层面的 `path.resolve` + `path.relative` 包含性判断，不调用 `realpath`。同步根内的符号链接可以指向根外，后续 `readFileSync` / `writeFileSync` / `unlinkSync` 会跟随链接，从而越过根目录边界。这直接违背 README 第 17 行 “Safe file operations with path traversal protection” 的表述。

**证据**（真实 HTTP；`root/link -> outside/`）：

```text
GET via symlink -> 200 SECRET
POST via symlink -> 200 outside/planted.txt = PWNED
```

即：通过 `GET /api/file?path=link/secret.txt` 读到了同步根之外的文件，通过 `POST /api/file`（`X-Path: link/planted.txt`）在根外写入了文件。

**影响**：持有有效 token 的客户端可借同步根内预置的 symlink 读写根外内容；如果该目录来自不可信来源（例如同步下来的仓库内容本身包含 symlink），风险进一步放大。威胁模型需要 token + 根内 symlink，但“路径穿越保护”的承诺在该场景下不成立。

**建议**：在 `sanitizePath` 中对已存在路径做 `fs.realpathSync`（对不存在的写入目标则对最近的已存在父目录做 realpath），再校验结果位于 `realpath(rootDir)` 之内。同时补一条 symlink 拒绝/限制的测试。

---

## 6. Windows 服务端把反斜杠相对路径直接交给忽略规则匹配（跨平台缺陷）

**位置**：`src/server.js:177`（`path.relative` 原样）、`src/server.js:179`（传给 `shouldIgnore`）、`src/server.js:182`（输出前才 `normalizePath`）

**问题**：Windows 上 `path.relative` 产出反斜杠路径，`shouldIgnore` 在归一化之前就被调用。不同规则受影响程度不同，部分简单规则只是“碰巧”命中，锚定规则和嵌套目录名会失效。

**证据**（直接调用导出的 `shouldIgnore`，用反斜杠模拟 Windows 输入）：

| 路径 | 规则 | 正斜杠结果 | 反斜杠结果 |
|---|---|---|---|
| `src/gen/x.js` | `src/gen/` | `true` | `false` |
| `a/node_modules` | `node_modules` | `true` | `false` |
| `sub/a.log` | `sub/*.log` | `true` | `false` |
| `dist/app.js` | `dist/` | `true` | `true` |
| `sub/a.log` | `*.log` | `true` | `true`（碰巧命中，不具代表性） |

```text
shouldIgnore("src\\gen\\x.js", ["src/gen/"])   = false
shouldIgnore("a\\node_modules", ["node_modules"]) = false
shouldIgnore("sub\\a.log", ["sub/*.log"])      = false
```

**影响**：Windows 服务端列出的文件与客户端本地扫描的过滤结果不一致。客户端已把路径归一为 `/` 后再判断，服务端没有。典型后果：本应忽略的 `src/gen/**` 或嵌套 `node_modules` 会被列出，pull 时下载、push 时被当作对端多余文件删除。

**说明（审查局限）**：本项是在 macOS 上用反斜杠字符串调用同一函数得到的函数级证据，不是在真实 Windows 上跑完整同步；结论依赖“Windows 上 `path.relative` 返回反斜杠”这一平台事实。

**建议**：在 `walkDir` 中先 `normalizePath(relativePath)`，再用于 `shouldIgnore` 和 `directories.push`；与客户端 `scanLocalFiles` 的做法保持一致。

---

## 7. 文档残留不一致

**证据与位置**：

- `docs/devlog-remote-exec.md:170` 仍写“diff 判定只用 hash，不复用 push/pull 的 mtime+size 快路径”，但该快路径已在本次改动中删除，描述过时。
- `DESIGN.md:56-58` 的 `/api/list` 响应示例仍只有 `path/size/mtime`，没有 `hash`，而同一文档 `DESIGN.md:333-337` 已加入 `hash`，两处自相矛盾。
- `README.md:93-109` 仍写 `pull [pattern]` / `push [pattern]` 单数形式，而 CLI 帮助与实现已是 `[path ...]`。
- 新增的“任一传输失败则跳过全部计划删除”是用户可见语义，目前只在 CLI 输出中出现，文档没有说明。

**建议**：随代码一起更新上述四处；尤其是删除语义，属于用户需要预期的行为。

---

## 8. 维护性问题（低）

- **死代码/未使用导出**：`checkServerReachable`（`src/client.js:103`）与 `getPidCommand`（`src/server.js:592`）已不被生产代码调用，仅测试引用（`src/cli.js:10` 已不再导入 `getPidCommand`）。
- **Node 版本声明偏松**：`package.json:15` 写 `>=18.0.0`，但 `src/cli.js:3` 使用的 `parseArgs` 在 Node 18.3.0 才加入；`setup.sh` 也只校验主版本。建议改为 `>=18.3`。
- **测试命名过时**：`test/test-client.js:196` 的用例名是 “skips unchanged files (mtime match)”，实际已改为按 hash 跳过。
- **测试文件未跟踪**：`git status` 显示 `?? test/test-sync-failures.js`，提交时需要纳入版本库，否则新增的失败安全用例不会随仓库分发。

---

## 9. `--json` / 大批量输出在 `process.exit()` 时被截断到 64 KiB

**位置**：`src/cli.js:487-490`（`diff --json`）、`src/cli.js:541-547`（`exec --json`）；同类写法也出现在 `src/cli.js:362-383`、`435-457` 的失败列表输出后

**问题**：`console.log()` 在 stdout 是管道时走异步写入；紧接着调用 `process.exit()` 会立即终止进程，管道缓冲区（本机实测 65536 字节）之后尚未写出的数据被丢弃。Node.js 文档也明确提示 `process.exit()` 可能丢失待写入的 stdout/stderr。

**证据 1（机制层）**：

```text
$ node -e "console.log('x'.repeat(5*1024*1024)); process.exit(1)" | wc -c
   65536
$ node -e "console.log('x'.repeat(5*1024*1024))" | wc -c
 5242881
```

**证据 2（端到端）**：临时目录中让服务端拥有 500 个文件、客户端为空，执行真实的 `lansyncopt diff --json`，通过 `execFile` 以管道读取 stdout：

```text
exit code = 1
stdout bytes = 65536
JSON.parse = failed: Expected ',' or '}' after property value in JSON at position 65536
tail = "r\": {\n        \"size\": 1,\n        \"mtime\": 17946646"
```

输出恰好停在 65536 字节，JSON 在中间被截断。

**影响**：
- agent/脚本解析 `diff --json` 时会拿到非法 JSON；而退出码（0/1/2）仍然正确，只检查 `$?` 的调用方不会察觉。
- `exec --json` 返回的 `stdout` 字段较大时同样会被截断，构建日志等长输出场景风险高。
- 文本模式下文件数很多的 diff、大量失败项列表也会被截断。

**建议**：不要用 `process.exit(code)` 结束进程。改为设置 `process.exitCode = code` 并正常返回；或使用 `process.stdout.write(data, () => process.exit(code))`，等待写入回调后再退出。`exec` 场景还要注意 stdout/stderr 的写入顺序。

> 这是既有问题，不是本次未提交改动引入的；但本次改动的重点是让 `--json` 成为 agent 的稳定接口，因此现在更值得修。

---

## 附 A：审查中怀疑过、验证后不成立的疑点

这一节记录我原本怀疑有问题、但通过代码或实验确认“并非如此”的点，避免后来者重复排查。

| # | 原疑点 | 验证方法 | 结论 |
|---|--------|----------|------|
| A1 | 删除 mtime+size 快路径会导致每次同步多做 I/O | 阅读扫描代码：客户端 `scanLocalFiles`（`src/client.js:292-294`）和服务端 `walkDir`（`src/server.js:185-187`）本来就会读全文算 MD5；快路径作用在已有 hash 之后 | 无额外 I/O，删除是纯收益 |
| A2 | 去掉 `checkServerReachable` 会丢失清晰的网络/鉴权错误 | 追踪 `fetchFileList` → `apiFetch` → `describeFetchError`；运行 `test/test-sync-failures.js`（断言 401、500、`Cannot reach`）；整套 142 tests 通过 | 错误信息仍然可操作 |
| A3 | `fetchFileList` 要求 `files` 是数组会破坏旧服务端 | 检查 `exists:false` 分支仍返回 `{ files: [], ... }`（`src/server.js:424-426`）；`git log -S "createHash('md5')"` 确认 hash 早在 `25ba4f6` 就存在；跨平台测试用旧形态 mock（含 `files`）并通过 | 不构成兼容问题 |
| A4 | `selectScope` 在旧服务端（无 `directories`）或反斜杠路径下会误报 “No matching path” | 阅读父目录推断逻辑（`src/client.js:529-536`）；运行 `test/test-client.js:571-626`（旧服务端反斜杠形态 + `pattern: 'docs'`）；集成测试覆盖空目录范围 | 推断逻辑覆盖了该场景 |
| A5 | 远端空目录执行 pull 会误删本地文件 | 检查 `exists` 语义与 `handleList` 空目录返回；对照 `docs/sync-scope-design.md` 的空目录表 | 属有意设计：目录存在即镜像，目录不存在才拒绝 |
| A6 | `test-sync-failures.js` 全局 mock `fs.readFileSync` 会污染其他测试 | 单独运行 `node --test test/test-sync-failures.js`（3 pass）；`node --test` 每个文件独立进程，且 `t.mock` 自动还原 | 不会泄漏 |
| A7 | 版本号从 `opt.1` 跳到 `opt.3` 是笔误或漏改 | 检查 `package.json` 与 `package-lock.json` 两处版本一致；`VERSION` 只用于显示/探测 | 仅版本标识，无功能影响 |
| A8 | `X-Path` 只解码一次，不会触发二次解码问题 | 用真实 HTTP 向 `POST /api/file` 发送 `X-Path: 100%25.txt` | **判断错误**：同样返回 403，已并入问题 4 |
| A9 | `console.log` 大输出后 `process.exit()` 是否真的会截断 | 用 5 MiB 输出对比 `process.exit` 与正常结束；再用 `diff --json` 端到端复现 | **判断正确**：确认截断，已列为问题 9 |

## 附 B：仍未验证的疑点

以下点只有代码推断，本次没有做运行时验证，**不列为已确认问题**，仅提示后续留意：

- **`isOwnDaemon` 的精确路径匹配**（`src/server.js:690-698`）：命令前缀要求 `process.execPath + fileURLToPath(server.js) + ' --daemon '` 完全匹配。如果 CLI 与 daemon 来自不同安装路径（例如仓库 `node bin/lansync.js` vs `~/.lansyncopt/app`），或 daemon 在 Node 升级前启动，`server stop` 可能把自家 daemon 判成“another process”。正常通过已安装的 `lansyncopt` 命令操作时路径一致，应不受影响。验证方法：用两个不同路径的副本分别启动 CLI 和 daemon，再执行 `server stop`。
- **`server stop` 的 SIGTERM 竞态**（`src/cli.js:181-200`）：`stopServerDaemon()` 发送 SIGTERM 后立即返回，随后马上查询端口占用；若 daemon 尚未退出，可能看到旧 PID 并触发一次多余的提示/确认。验证方法：启动真实 daemon 后立即 `server stop`，观察是否出现 “port is still occupied” 警告。
- **`server stop` 的非默认端口**（`src/cli.js:179`）：配置文件丢失后端口回退到 `DEFAULT_PORT`，在非默认端口上运行的孤儿 daemon 无法被这条命令发现。验证方法：用 `--port` 启动后删除 `server.json` 再执行 stop。
- **符号链接与 `exclude`/ignore 的交互**：本次只验证了 symlink 越界读写；未验证 symlink 指向同步根内部时目录遍历、哈希、删除的行为。验证方法：根内建立指向根内另一目录的 symlink，分别执行 diff/push/pull 观察是否重复/漏项。

## 附 C：其他经核查不认定为缺陷的事项

- **传输失败时跳过全部删除**（`src/client.js:618-619`、`698-699`）：保守且安全，避免“部分传输成功却删掉了对端多余文件”；新测试已固定该行为。代价是删除变成全有或全无，但在失败场景下这是可接受的设计。
- **Windows 简单规则的部分命中**：`*.log`、`dist/` 等规则在反斜杠输入下也会命中，但这是 minimatch 的偶然行为，不能作为“忽略规则在 Windows 上正常”的证据；见问题 6 的分项表。
- **mtime 快路径、`checkServerReachable`、`files` 数组校验**：已在附 A 的 A1–A3 中逐条验证，不属于缺陷。

---

## 附录：复现脚本

以下脚本在临时目录运行，不修改仓库。需要在本机以 Node.js 18+ 用 `node --input-type=module` 执行（脚本使用顶层 await 和 `fetch`）：

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-ev-'));
process.env.LANSNC_CONFIG_DIR = path.join(tmp, 'cfg');
fs.mkdirSync(path.join(tmp, 'cfg'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'cfg', 'server.json'), JSON.stringify({ token: 't', policy: 'normal' }));

const { createServer, sanitizePath, shouldIgnore } = await import('/path/to/lansync/src/server.js');
const { scanLocalFiles } = await import('/path/to/lansync/src/client.js');

// 问题 4：含 % 的文件名
const root = path.join(tmp, 'root');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, '100%.txt'), 'percent');
console.log('sanitizePath("100%.txt") =', sanitizePath('100%.txt', root));

const server = createServer(root);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const h = { Authorization: 'Bearer t' };
const r1 = await fetch(base + '/api/file?path=' + encodeURIComponent('100%.txt'), { headers: h });
console.log('GET percent-name ->', r1.status, (await r1.text()).slice(0, 80));
const rp = await fetch(base + '/api/file', {
  method: 'POST',
  headers: { ...h, 'X-Path': encodeURIComponent('100%.txt') },
  body: 'ok'
});
console.log('POST percent-name (X-Path) ->', rp.status,
  'exists =', fs.existsSync(path.join(root, '100%.txt')));

// 问题 5：symlink 越界读写
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
fs.symlinkSync(outside, path.join(root, 'link'));
const r2 = await fetch(base + '/api/file?path=link/secret.txt', { headers: h });
console.log('GET via symlink ->', r2.status, (await r2.text()).slice(0, 40));
const r3 = await fetch(base + '/api/file', {
  method: 'POST',
  headers: { ...h, 'X-Path': encodeURIComponent('link/planted.txt') },
  body: 'PWNED'
});
console.log('POST via symlink ->', r3.status,
  'outside/planted.txt =',
  fs.existsSync(path.join(outside, 'planted.txt'))
    ? fs.readFileSync(path.join(outside, 'planted.txt'), 'utf8')
    : 'absent');
server.close();

// 问题 3：.gitignore 基准目录
const wk = path.join(tmp, 'work');
fs.mkdirSync(path.join(wk, 'src', 'generated'), { recursive: true });
fs.writeFileSync(path.join(wk, '.gitignore'), 'src/generated/\n');
fs.writeFileSync(path.join(wk, 'src', 'generated', 'out.js'), 'x');
const rules = ['src/generated/'];
console.log('scan(workDir)    ->', scanLocalFiles(wk, rules).map(f => f.path));
console.log('scan(workDir/src)->', scanLocalFiles(path.join(wk, 'src'), rules).map(f => f.path));

// 问题 6：Windows 反斜杠忽略规则
console.log("shouldIgnore('src\\gen\\x.js', ['src/gen/']) =", shouldIgnore('src\\gen\\x.js', ['src/gen/']));
console.log("shouldIgnore('a\\node_modules', ['node_modules']) =", shouldIgnore('a\\node_modules', ['node_modules']));
console.log("shouldIgnore('sub\\a.log', ['sub/*.log']) =", shouldIgnore('sub\\a.log', ['sub/*.log']));

// 问题 2：扫描器 fail-loud
const locked = path.join(tmp, 'locked');
fs.mkdirSync(locked);
fs.writeFileSync(path.join(locked, 'f'), 'x');
const orig = fs.readFileSync;
fs.readFileSync = () => { throw new Error('Cannot read locked/file'); };
try {
  scanLocalFiles(locked, []);
  console.log('scan unreadable -> no throw');
} catch (e) {
  console.log('scan unreadable -> throws:', e.message);
}
fs.readFileSync = orig;

fs.rmSync(tmp, { recursive: true, force: true });
```

问题 9 的机制可直接复现：

```bash
node -e "console.log('x'.repeat(5*1024*1024)); process.exit(1)" | wc -c   # 65536
node -e "console.log('x'.repeat(5*1024*1024))" | wc -c                    # 5242881
```

端到端复现做法：在临时目录启动 `createServer`，服务端放 500 个文件、客户端目录留空，写入 `client.json` 后用 `execFile` 执行 `diff --json` 并捕获管道 stdout。实测 `stdout bytes = 65536`，`JSON.parse` 在 position 65536 处失败。

问题 1 可直接用 CLI 复现：

```bash
node bin/lansync.js exec git status     # Error: Invalid arguments for exec
node bin/lansync.js exec ls -la         # Error: Unknown option '-l'
node bin/lansync.js exec "git status"   # 通过参数解析
```

## 2026-11-15 复核：运行证据与修复决定

判定依据是现行[同步范围设计](sync-scope-design.md)和[远程执行设计](remote-exec-design.md)。无参数 push/pull 镜像当前子树，显式路径只传输选中的文件。diff 只读比较两端选中路径的并集，以 MD5 判断同路径文件内容。忽略文件和工作根以外的文件都应受到保护。空目录可以用来选范围，本身不构成文件差异。

本机使用 macOS、Node v22.22.0、HEAD `14d92d4` 加当前工作区，运行 `npm test` 得到 142/142 通过。下表中的本机 CLI 实验另建临时 client、server、配置目录和回环 HTTP 服务，调用仓库的 `bin/lansync.js`。Windows 实验通过已连接的稳定版 lansync，在远端项目中加载源码，数据放在系统临时目录。

### 确定应该修

| 原编号 | 补测结果 | 修复范围与理由 |
|---|---|---|
| #3 子目录忽略规则 | 两端根目录的 `.gitignore` 都写 `src/generated/`，两端都有 `src/`，仅本地有 `src/generated/x`。在本地 `src/` 执行无参数 `pull`，退出 0，随后检查发现 `x` 已被删除。 | 优先修复。客户端扫描时用相对工作根的路径匹配根规则，同时保留相对当前目录的路径供范围选择。用同一夹具覆盖 diff 不列出、push 不上传、pull 保留忽略文件。 |
| #4 文件名二次解码 | 本地建立字面名 `report%2Ffinal.txt`，显式 push 退出 0，远端实际创建 `report/final.txt`。原审查另测得 `100%.txt` 的 GET、POST、DELETE 返回 403。 | 协议入口仅解码一次，随后按字面路径做根边界检查。覆盖 list、下载、上传及带 scope 的删除；测试中让两个名字同时存在，验证操作只影响指定文件，并保留对真正越界路径的拒绝。 |
| #5 链接越界 | 本地 `files` 链到工作根外的临时目录；远端有 `files/x`。执行 `pull files/x` 退出 0，根外出现 `x`。服务端另建同类链接，带 token 的 GET 返回 200。本次关闭了远程 exec。Windows 上用真实 junction 调用远端项目的 `sanitizePath('link/x', root)`，用返回路径读到了根外标记。 | 客户端落盘和服务端文件接口都要约束实际访问位置，覆盖链接父目录、尚未创建的目标、删除及修剪边界。合法 token 也只能同步配置范围。根内链接的复制、跟随方式留待单独设计。 |
| #6 Windows 忽略目录进入范围清单 | 真实 Windows（win32、Node v24.14.0）创建 `src/gen/x.js`、`a/node_modules/lib.js`、`sub/a.log` 和 `keep.txt`。按原审查三条规则实际运行 `walkDir`，文件仅返回 `keep.txt`；但目录清单含 `src/gen`。同一规则 `src/gen/` 匹配目录自身时，反斜杠输入为 false，正斜杠为 true。 | 在服务端调用 `shouldIgnore` 前统一分隔符，使被忽略目录在遍历和加入目录清单前就被排除。目录清单参与显式范围判断。原审查推断的三个文件泄漏、继而误删，在这次 Windows 夹具中均未复现。 |
| #9 管道输出截断 | 远端子目录有 1,000 个文件，本地对应目录为空。用子进程管道接收真实 `diff --json`，退出码 1，stdout 恰为 65,536 字节，`JSON.parse` 失败。子进程采集上限为 4 MB。 | 修复有待写输出时强制退出的命令分支，保留 diff 的 0/1/2 语义。验收要解析完整 JSON 并核对 1,000 项。exec JSON、文本和失败清单有同类写法，应检查输出是否写完；本次端到端复现的是 diff JSON。 |

Windows 远端与本机使用的 minimatch 都是 9.0.9，`shouldIgnore.toString()` 的 SHA-256 相同，`walkDir.toString()` 的摘要不同。两端均在 `shouldIgnore(relativePath, ignoreRules)` 处判断；本机源码也在判断之后才归一化目录路径。Windows 的清单结果来自远端现有源码，本机这份完整工作区尚未在 Windows 上重跑。

**#7、#8 中应处理的交付问题。** README 的 push/pull 示例仍写单个 `[pattern]`，DESIGN 的早期清单示例缺 hash，也应明确任一文件传输失败会跳过本轮计划删除。当前说明应与命令和失败测试对齐。测试名 `skips unchanged files (mtime match)` 应改为与实际 hash 断言一致；提交改造时应纳入当前仍未跟踪的 `test/test-sync-failures.js`，上面的 142 项包含这个文件。安装兼容性也确有缺口：`package.json` 声明 Node >=18.0.0，`setup.sh` 只查主版本，而 CLI 在加载时就导入了 18.3.0 才提供的 `util.parseArgs`。应对齐安装检查、包声明和文档；最终声明的最低版本需用该版本实际跑 CLI，本次没有验证 18.3.0 对整个项目是否充分。[Node 18.3.0 API 记录](https://nodejs.org/download/release/v18.3.0/docs/api/util.html#utilparseargsconfig)

### 确定应保留的行为

- **#1 保留 exec 的单命令字符串接口。** 历史源码确实会 join 多个参数；本次运行 `exec git status` 和 `exec ls -la` 都在解析阶段失败。远程执行设计明确要求整条命令用引号传入，才能让调用方控制远端收到的命令及 shell 运算符。应改进参数错误提示，给出 `exec "git status"` 示例并说明兼容性变化。此次多路径改造只需要 push/pull/diff 接受多个路径。
- **#2 保留清单不完整即失败，以及传输失败跳过删除。** 失败测试注入读错误、缺失 files、HTTP 401/500，并检查请求与磁盘状态；恢复后再次执行会重新请求清单。将漏扫文件当成源端缺失会产生错误的删除计划。自动重试清单和支持部分清单都属于额外行为，本轮保持现有语义。
- **保留 MD5、范围和空目录语义。** 两端同路径文件用本次清单的 hash 比较，mtime 或大小相同不足以跳过。存在但为空的源子目录可执行无参数镜像；远端对应子目录不存在时 pull 拒绝镜像。显式路径保留目标独有文件。只有成功删除文件才向上修剪至范围根，diff 不创建或修剪空目录。以上行为已有设计与用例，修复 #3–#6 时应保留。
- **#7、#8 的维护边界。** 带日期的开发日志保留当时的 mtime 快路径记录，可以追加指向现行设计的说明。两个辅助函数如今只有测试调用；没有观察到它们改变同步行为，本轮无需删除导出或恢复业务调用。附 B 的 daemon 识别、停止竞态、配置丢失和根内链接策略仍缺具体复现或设计决定，继续保留为待定项。
