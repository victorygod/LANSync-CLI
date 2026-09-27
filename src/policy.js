// src/policy.js
// 远程命令执行的分级管控逻辑:token 派生、黑/灰名单匹配、动态自引用检测。
import crypto from 'node:crypto';

const TOKEN_SALT = 'lansync-cli-v1';

// ===== 默认黑名单(灾难性,除 allow-all 外都拦) =====
export const DEFAULT_BLACKLIST = [
  // Unix / Linux / macOS
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -fr /',
  'dd',
  'mkfs',
  'mkfs.ext4',
  'mkfs.xfs',
  'fdisk',
  'parted',
  'wipefs',
  'find / -delete',
  'find / -exec rm',
  'chmod -R 777 /',
  'chmod 000 /',
  'diskutil eraseDisk',
  'diskutil eraseVolume',
  'diskutil zeroDisk',
  '> /dev/sda',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  'systemctl poweroff',
  'systemctl reboot',
  'systemctl halt',
  ':(){ :|:& };:',
  'iptables -F',
  'ufw disable',
  'history -c',
  'sudo su',
  'sudo -i',
  'sudo -s',
  'sudo bash',
  'su -',
  'su root',
  'doas',
  'pkexec',
  // Windows (cmd.exe)
  'format',
  'diskpart',
  'fsutil',
  'del /s /q C:\\',
  'rd /s /q C:\\',
  'takeown',
  'icacls',
  'cacls',
  'logoff',
  'bcdedit',
  'reg delete',
  'reg add',
  'reg import',
  'regsvr32',
  'sc delete',
  'net user',
  'net localgroup',
  'runas',
  'certutil -urlcache',
  'bitsadmin',
  'mshta',
  'rundll32',
  'schtasks',
  'powershell -EncodedCommand',
  // Windows (PowerShell)
  'Remove-Item C:\\ -Recurse -Force',
  'Format-Volume',
  'Clear-Disk',
  'Stop-Computer',
  'Restart-Computer',
  'New-LocalUser',
  'Add-LocalGroupMember',
  'Set-NetFirewallProfile',
  'Enable-PSRemoting',
  'Disable-ComputerRestore',
  'Invoke-Expression',
  // Server 自身保护(防误杀 lansync server / node 全家)
  'killall node',
  'pkill -f lansync',
  'pkill -f server.js',
  'taskkill /f /im node.exe',
  'wmic process where name="node.exe" delete',
  'Stop-Process -Name node'
];

// ===== 默认灰名单(高频半安全,仅 block-black-gray 模式拦) =====
export const DEFAULT_GRAYLIST = [
  // Unix / Linux / macOS
  'sudo',
  'kill',
  'pkill',
  'killall',
  'rm',
  'chmod',
  'chown',
  'shred',
  'find -delete',
  'find -exec rm',
  'git reset --hard',
  'git clean',
  'git push --force',
  'git push -f',
  'systemctl stop',
  'systemctl disable',
  'systemctl mask',
  'systemctl restart',
  'service stop',
  'service restart',
  'npm uninstall',
  'npm publish',
  'npm unpublish',
  'pip uninstall',
  'brew uninstall',
  'apt remove',
  'apt purge',
  'yum remove',
  'docker rm',
  'docker rmi',
  'docker system prune',
  'docker volume rm',
  'docker stop',
  'docker kill',
  // Windows (cmd.exe)
  'del',
  'del /f /s /q',
  'rd',
  'rd /s /q',
  'taskkill',
  'net stop',
  // Windows (PowerShell)
  'Remove-Item',
  'Stop-Process',
  'Stop-Service',
  'Restart-Service'
];

// 派生 token:HMAC-SHA256(口令, 盐)。双方输入同口令 → 得到相同 token。
export function deriveToken(password) {
  return crypto.createHmac('sha256', TOKEN_SALT).update(password).digest('hex');
}

// 归一化:小写 + 路径分隔符统一。
// - Windows 命令不区分大小写,小写后可拦 `DEL /S /Q` 这类变体
// - 把 `\` 归一为 `/`,避免 Windows 路径分隔符变体绕过
// 注意:别名转义(`\rm`)与编码混淆仍可绕过,这是黑名单的固有限制,靠鉴权+审计兜底。
export function normalizeCommand(cmd) {
  return cmd.replace(/\\/g, '/').toLowerCase();
}

// 单条规则匹配:精确 或 词边界前缀。
// 用 `startsWith(rule + ' ')` 而非裸前缀,是为了:
//   - `rm -rf /` 能精确拦根删除,但不会误拦 `rm -rf /home/x`(定向绝对路径)
//   - `sudo` 能拦 `sudo apt install`,但 `sudo su` 由黑名单里的精确项先拦
function matchesRule(normalizedCmd, rule) {
  const r = normalizeCommand(rule);
  return normalizedCmd === r || normalizedCmd.startsWith(r + ' ');
}

// 判断命令是否命中某个名单,命中则返回命中的规则(否则 null)。
export function matchesList(command, list) {
  const cmd = normalizeCommand(command);
  for (const rule of list) {
    if (matchesRule(cmd, rule)) return rule;
  }
  return null;
}

// 分级判定:黑名单优先,再按 policy 决定是否拦灰名单。
// policy: allow-all | block-black | block-black-gray
export function checkPolicy(command, policy, blacklist = DEFAULT_BLACKLIST, graylist = DEFAULT_GRAYLIST) {
  if (policy === 'allow-all') {
    return { blocked: false, list: null, matched: null };
  }

  const blackHit = matchesList(command, blacklist);
  if (blackHit) {
    return { blocked: true, list: 'black', matched: blackHit };
  }

  if (policy === 'block-black-gray') {
    const grayHit = matchesList(command, graylist);
    if (grayHit) {
      return { blocked: true, list: 'gray', matched: grayHit };
    }
  }

  return { blocked: false, list: null, matched: null };
}

// 动态自引用检测:命令里出现 server 自身标识(PID / 配置目录 / 代码路径 / 工具名)→ 拒绝。
// 返回命中的标识(否则 null)。这是黑名单无法静态覆盖的自毁防线。
export function detectSelfReference(command, identifiers) {
  const cmd = normalizeCommand(command);
  for (const id of identifiers) {
    if (!id) continue;
    const normalized = normalizeCommand(String(id));
    if (normalized && cmd.includes(normalized)) {
      return id;
    }
  }
  return null;
}
