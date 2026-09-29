# lansync 设计方案

一个极简的局域网代码同步工具，用于在局域网内的多台机器之间同步代码文件。

## 一、项目结构

```
lansync/
├── package.json
├── bin/
│   └── lansync.js          # CLI 入口
├── src/
│   ├── server.js           # 服务器核心逻辑
│   ├── client.js           # 客户端核心逻辑
│   └── config.js           # 配置管理（存储在用户目录）
└── README.md
```

## 二、技术选型

| 功能 | 方案 | 理由 |
|------|------|------|
| HTTP Server | Node.js 原生 `http` 模块 | 零依赖，极简 |
| 后台运行 | `child_process.spawn` + `detached` | 跨平台，无额外依赖 |
| 局域网 IP | `os.networkInterfaces()` | 原生 API，无依赖 |
| 文件操作 | `fs` + `path` | 原生模块 |
| 通配符匹配 | `minimatch` | 支持 glob 模式和 .gitignore 解析 |
| HTTP Client | 原生 `fetch`（Node 18+） | 无需 axios |
| 配置存储 | `~/.lansync/config.json` | 简单 JSON 文件 |

## 三、API 设计（Server 端）

所有 API 使用普通文本/二进制传输，批量操作通过客户端多次调用实现。
所有 `path` 参数必须经过路径遍历校验，禁止包含 `..` 或访问根目录外的路径。

### 3.1 文件操作 API

```
GET  /api/list?path=<相对路径>     # 递归列出所有文件（返回完整相对路径数组）
GET  /api/file?path=<相对路径>     # 下载单个文件（返回文件内容）
POST /api/file                     # 上传文件（body 为文件内容）
DELETE /api/file?path=<相对路径>   # 删除文件
```

### 3.2 API 详细说明

#### GET /api/list
请求参数：`path` - 相对路径（可选，默认为根目录）

**递归返回指定路径下所有文件**，每个文件包含路径、大小和修改时间。

响应示例：
```json
{
  "files": [
    { "path": "readme.md", "size": 1024, "mtime": 1679587200000 },
    { "path": "package.json", "size": 512, "mtime": 1679587100000 },
    { "path": "src/index.js", "size": 2048, "mtime": 1679587300000 }
  ]
}
```

#### GET /api/file
请求参数：`path` - 文件相对路径（必填）

响应：文件原始内容（Content-Type: application/octet-stream）

#### POST /api/file
请求头：`X-Path: <相对路径>`
请求体：文件原始内容

响应示例：
```json
{ "success": true, "path": "src/index.js" }
```

#### DELETE /api/file
请求参数：`path` - 文件相对路径（必填）

响应示例：
```json
{ "success": true }
```

## 四、相对路径与执行目录

### 4.1 核心概念

- **工作目录（workDir）**：执行 `lansync client config` 时记录的当前目录，作为 client 的根目录
- **执行目录（currentDir）**：执行 `lansync push/pull` 命令时的当前目录
- **相对路径前缀（pathPrefix）**：执行目录相对于工作目录的路径

### 4.2 执行目录规则

Client 只能在工作目录及其子目录下执行 `push/pull` 命令：

```
工作目录: /Users/xxx/project

✅ 允许执行:
   /Users/xxx/project              (pathPrefix: "")
   /Users/xxx/project/src          (pathPrefix: "src")
   /Users/xxx/project/src/utils    (pathPrefix: "src/utils")

❌ 拒绝执行:
   /Users/xxx                      (在工作目录之外)
   /Users/other/project            (完全不同的路径)
```

### 4.3 子目录执行示例

假设工作目录为 `/Users/xxx/project`，server 根目录为 `/Server/project`：

| 执行目录 | pathPrefix | push 行为 | pull 行为 |
|---------|------------|-----------|-----------|
| `/Users/xxx/project` | `""` | 上传所有文件到 server 根目录 | 从 server 根目录下载所有文件 |
| `/Users/xxx/project/src` | `"src"` | 上传 src/* 到 server 的 src/ | 从 server 的 src/ 下载到本地 src/ |
| `/Users/xxx/project/src/utils` | `"src/utils"` | 上传 src/utils/* 到 server 的 src/utils/ | 从 server 的 src/utils/ 下载 |

### 4.4 路径遍历防护

Server 端必须校验所有 `path` 参数：

```javascript
function sanitizePath(requestedPath, rootDir) {
  // 解码 URL 编码
  const decoded = decodeURIComponent(requestedPath);

  // 禁止路径遍历
  if (decoded.includes('..') || decoded.includes('\0')) {
    return null; // 拒绝访问
  }

  // 规范化路径
  const absolutePath = path.resolve(rootDir, decoded);

  // 确保在根目录内
  if (!absolutePath.startsWith(rootDir)) {
    return null; // 拒绝访问
  }

  return absolutePath;
}
```

## 五、命令设计

### 5.1 Server 命令

```bash
lansync server start              # 启动后台服务，返回 IP:port
lansync server stop               # 停止服务
lansync server status             # 输出 IP:port、根目录、运行状态
```

### 5.2 Client 命令

```bash
lansync client config <ip:port>   # 配置服务器地址（同时记录当前工作目录）
lansync pull [pattern] [--no-delete]  # 拉取文件（无参数=完整同步）
lansync push [pattern] [--no-delete]  # 推送文件（无参数=完整同步）
lansync client status             # 查看当前配置
```

### 5.3 参数说明

| 参数 | 说明 |
|------|------|
| `pattern` | 可选，glob 模式过滤文件，如 `*.js` 或 `src/**` |
| `--no-delete` | 不删除目标端多余文件，只同步新增和修改的文件 |

## 六、核心流程

### 6.1 Server Start 流程

```
1. 检查 8001 端口是否被占用
2. 获取本机局域网 IP（过滤 192.168.x.x / 10.x.x.x）
3. fork 子进程后台运行 HTTP Server（detached: true）
4. 将 PID 和配置写入 ~/.lansync/server.json
5. 输出: "Server running at http://192.168.1.100:8001"
6. 输出: "Root directory: /Users/xxx/project"
```

### 6.2 Server Status 流程

```
1. 读取 ~/.lansync/server.json
2. 检查 PID 是否存活
3. 输出:
   - Status: running / stopped
   - IP: 192.168.1.100:8001
   - Root directory: /Users/xxx/project
```

### 6.3 Pull 流程

```
1. 读取 ~/.lansync/client.json 获取 server 地址和工作目录
2. 检查当前目录是否在工作目录内，若不在则拒绝执行并提示
3. 计算当前目录相对于工作目录的 pathPrefix
4. 读取工作目录下的 .gitignore（如存在）
5. GET /api/list?path=<pathPrefix> 获取 server 端文件列表（含 size/mtime）
6. 根据 .gitignore 规则过滤文件列表
7. 如有 pattern 参数，再次用 glob 过滤
8. 对比本地文件：
   - server 有、本地无 → 下载
   - server 有、本地有、size 或 mtime 不同 → 下载
   - server 有、本地有、size 和 mtime 都相同 → 跳过
   - server 无、本地有、无 --no-delete → 删除本地文件
9. 逐个调用 GET /api/file 下载文件
10. 保持目录结构写入本地
11. 清理空目录
12. 输出同步汇总（下载数量、跳过数量、删除数量、文件列表）
```

### 6.4 Push 流程

```
1. 读取配置
2. 检查当前目录是否在工作目录内，若不在则拒绝执行并提示
3. 计算当前目录相对于工作目录的 pathPrefix
4. 读取工作目录下的 .gitignore（如存在）
5. 扫描当前目录所有文件（获取 size/mtime）
6. 根据 .gitignore 规则过滤文件列表
7. 如有 pattern 参数，再次用 glob 过滤
8. GET /api/list?path=<pathPrefix> 获取 server 端文件列表（含 size/mtime）
9. 对比 server 端文件：
   - 本地有、server 无 → 上传
   - 本地有、server 有、size 或 mtime 不同 → 上传
   - 本地有、server 有、size 和 mtime 都相同 → 跳过
   - 本地无、server 有、无 --no-delete → 删除 server 文件
10. 逐个调用 POST /api/file 上传文件
11. 逐个调用 DELETE /api/file 删除 server 端多余文件
12. 输出同步汇总（上传数量、跳过数量、删除数量、文件列表）
```

## 七、配置文件格式

### 7.1 Server 配置（~/.lansync/server.json）

```json
{
  "pid": 12345,
  "port": 8001,
  "rootDir": "/Users/xxx/project",
  "ip": "192.168.1.100"
}
```

### 7.2 Client 配置（~/.lansync/client.json）

```json
{
  "serverUrl": "http://192.168.1.100:8001",
  "workDir": "/Users/xxx/local-project"
}
```

## 八、.gitignore 支持

### 8.1 读取规则

- 在执行 `pull` 或 `push` 时，读取**工作目录**下的 `.gitignore` 文件
- 如果文件不存在，则不做过滤
- 使用 `minimatch` 库进行模式匹配

### 8.2 默认忽略规则

无论 `.gitignore` 是否存在，以下文件/目录始终忽略：

```
.git/
.lansync/
node_modules/
.DS_Store
Thumbs.db
```

### 8.3 忽略规则示例

`.gitignore` 文件示例：
```
dist/
*.log
.env
*.tmp
```

## 九、修改检测

### 9.1 检测策略

为避免传输未修改的文件，使用 **size + mtime** 双重校验：

| 检测项 | 说明 |
|--------|------|
| 文件大小 | 快速排除，size 不同则一定修改过 |
| 修改时间 | mtime 不同则认为修改过 |

### 9.2 API 扩展

修改 `/api/list` 响应，增加文件元信息：

```json
{
  "files": [
    {
      "path": "src/index.js",
      "size": 1024,
      "mtime": 1679587200000
    }
  ]
}
```

### 9.3 同步逻辑更新

**Pull 时：**
```
本地无文件 → 下载
本地有文件，size 或 mtime 不同 → 下载
本地有文件，size 和 mtime 都相同 → 跳过
```

**Push 时：**
```
server 无文件 → 上传
server 有文件，size 或 mtime 不同 → 上传
server 有文件，size 和 mtime 都相同 → 跳过
```

### 9.4 注意事项

- mtime 使用 Unix 时间戳（毫秒）
- 不同机器的时钟可能有偏差，但局域网内通常可忽略
- 如需更精确检测，可后续扩展为 hash 校验

## 十、关键实现细节

### 10.1 获取局域网 IP

```javascript
const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部地址和非 IPv4
      if (iface.family !== 'IPv4' || iface.internal) continue;

      // 优先返回 192.168.x.x，其次 10.x.x.x
      if (iface.address.startsWith('192.168.')) {
        return iface.address;
      }
      if (iface.address.startsWith('10.')) {
        results.push(iface.address);
      }
    }
  }

  return results[0] || '127.0.0.1';
}
```

### 10.2 后台运行（跨平台）

```javascript
const { spawn } = require('child_process');
const path = require('path');

function startDaemon() {
  const child = spawn(process.execPath, [
    path.join(__dirname, 'server.js'),
    process.cwd()
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  child.unref();
  return child.pid;
}
```

### 10.3 通配符匹配

```javascript
const minimatch = require('minimatch');

// 匹配文件路径
function matchPattern(filepath, pattern) {
  return minimatch(filepath, pattern, { dot: true });
}

// 解析 .gitignore
function parseGitignore(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}
```

### 10.4 递归获取文件列表

```javascript
const fs = require('fs');
const path = require('path');

function walkDir(dir, baseDir, ignoreRules) {
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      // 检查是否被忽略
      if (shouldIgnore(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const stat = fs.statSync(fullPath);
        results.push({
          path: relativePath,
          size: stat.size,
          mtime: stat.mtimeMs
        });
      }
    }
  }

  walk(dir);
  return results;
}
```

## 十一、依赖清单

```json
{
  "name": "lansync",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "lansync": "./bin/lansync.js"
  },
  "dependencies": {
    "minimatch": "^9.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

## 十二、安装方式

### 12.1 前置条件

- Node.js >= 18.0.0（支持原生 fetch）
- npm 或其他包管理器

### 12.2 安装步骤

```bash
# 进入项目目录
cd lansync

# 安装依赖
npm install

# 全局链接（macOS / Windows 通用）
npm link

# 验证安装
lansync --version
```

### 12.3 验证安装成功

```bash
# 查看版本
lansync --version

# 查看帮助
lansync --help

# 启动服务器测试
lansync server start
```

## 十三、边界情况处理

| 场景 | 处理方式 |
|------|----------|
| 端口被占用 | 提示 "Port 8001 is in use" 并退出 |
| Server 未启动 | Client 命令提示 "Server not reachable at <url>" |
| 文件不存在 | GET 返回 404，客户端跳过 |
| 目录不存在 | 自动创建（mkdir -p 语义） |
| 权限不足 | 提示 "Permission denied" |
| 网络超时 | 10 秒超时，提示 "Connection timeout" |
| .gitignore 语法错误 | 忽略错误行，继续解析 |
| 大文件 | 流式传输，不一次性读入内存 |
| 路径遍历攻击 | Server 校验 `..` 和路径边界，返回 403 |
| 执行目录在工作目录外 | 拒绝执行，提示 "Must run inside workDir: <path>" |
| 同步完成后有空目录 | 自动清理空目录（git 式修剪：pull 侧 client 本地清理；push 侧 server 删除文件成功后向上逐级 rmdir 空目录，到 rootDir 为止，非空即停，root 永不修剪） |

## 十四、命令行输出示例

### 14.1 server start

```
$ lansync server start
Server started successfully.
  URL: http://192.168.1.100:8001
  Root: /Users/xxx/my-project
  PID: 12345
```

### 14.2 server status

```
$ lansync server status
Server status: running
  URL: http://192.168.1.100:8001
  Root: /Users/xxx/my-project
  PID: 12345
```

### 14.3 client config

```
$ lansync client config 192.168.1.100:8001
Configured server: http://192.168.1.100:8001
Working directory: /Users/xxx/local-project
```

### 14.4 pull（根目录执行）

```
$ cd /Users/xxx/local-project
$ lansync pull
Connecting to http://192.168.1.100:8001...
Reading .gitignore rules...
Syncing files...

  Downloads:
    + src/index.js
    + src/utils.js
    + package.json

  Skipped (unchanged):
    ~ readme.md
    ~ config.json

  Deleted (not on server):
    - old-file.js

Sync complete: 3 downloaded, 2 skipped, 1 deleted
```

### 14.5 pull（子目录执行）

```
$ cd /Users/xxx/local-project/src
$ lansync pull
Connecting to http://192.168.1.100:8001...
Syncing path: src/
Reading .gitignore rules...

  Downloads:
    + index.js
    + utils.js

Sync complete: 2 downloaded, 0 skipped, 0 deleted
```

### 14.6 push（根目录执行）

```
$ lansync push
Connecting to http://192.168.1.100:8001...
Reading .gitignore rules...
Syncing files...

  Uploads:
    + src/index.js
    + src/utils.js
    + package.json

  Skipped (unchanged):
    ~ readme.md
    ~ config.json

  Deleted (not on client):
    - old-file.js

Sync complete: 3 uploaded, 2 skipped, 1 deleted
```

### 14.7 执行目录错误

```
$ cd /Users/xxx
$ lansync pull
Error: Must run inside workDir: /Users/xxx/local-project
Current directory: /Users/xxx
```

### 14.8 无变更

```
$ lansync pull
Connecting to http://192.168.1.100:8001...
Syncing files...

No changes. Already in sync.
```

### 14.9 使用 --no-delete

```
$ lansync pull --no-delete
Connecting to http://192.168.1.100:8001...
Reading .gitignore rules...
Syncing files...

  Downloads:
    + src/index.js

  Skipped (unchanged):
    ~ readme.md

Sync complete: 1 downloaded, 1 skipped, 0 deleted
(Note: 2 local files not on server were kept due to --no-delete)
```

## 十五、后续可扩展

- `--dry-run` 预览模式，不实际执行
- 传输进度条
- 多 server 支持
- 自动备份或类似git worktree的功能