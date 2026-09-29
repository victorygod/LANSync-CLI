// 临时诊断 v2:审计所有触碰 lansyncopt 配置类文件的 fs 调用(带调用栈)。
// 命中同时写到 stderr 和工作区 diag-hits.log(相对 __dirname,子进程切换 cwd 也能写)。
// 用法:NODE_OPTIONS="--require <绝对路径>/diag-audit.cjs" npm test
const fs = require('fs');
const path = require('path');
const hitLog = path.join(__dirname, 'diag-hits.log');
const KINDS = ['writeFileSync', 'unlinkSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'appendFile'];
for (const kind of new Set(KINDS)) {
  const orig = fs[kind];
  if (typeof orig !== 'function') continue;
  fs[kind] = function (...args) {
    const p = String(args[0]);
    if (p.includes('lansyncopt') && (p.includes('server.json') || p.includes('client.json') || p.includes('server.log'))) {
      const entry = `[AUDIT] fs.${kind} pid=${process.pid} ppid=${process.ppid} cwd=${process.cwd()}\n  -> ${p}\n${new Error('').stack.split('\n').slice(1, 9).join('\n')}\n---\n`;
      console.error(entry);
      try { fs.appendFileSync(hitLog, entry); } catch {}
    }
    return orig.apply(this, args);
  };
}
