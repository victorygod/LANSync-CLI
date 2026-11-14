import fs from 'node:fs';
import path from 'node:path';

function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Resolve existing links before accessing a file, including the parents of a new file.
export function resolveSyncPath(root, name) {
  if (name.includes('\0') || path.isAbsolute(name)) return null;
  const target = path.resolve(root, name);
  if (!within(root, target)) return null;
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      try {
        current = fs.realpathSync(current);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ELOOP') return null;
        throw err;
      }
      if (!within(realRoot, current)) return null;
    }
  }
  return current;
}

// Git 式空目录修剪:push 删掉某目录下最后一个文件后,从其父目录向上逐级
// 尝试 rmdir,到 rootDir 为止。只在删除成功后调用(文件已不在)。
// 只删「确认空」的目录,不用 rmSync recursive——目录里还有 ignore 文件
// (.DS_Store 等)或被 Windows 占用(EBUSY/EPERM,如资源管理器开着该目录)
// 时 rmdir 失败即停,留待下次 push 再试,与 git 遇到 ignored 文件时的行为一致。
export function pruneEmptyDirs(deletedFilePath, rootDir) {
  const root = path.normalize(rootDir);
  let current = path.dirname(deletedFilePath);

  while (true) {
    const rel = path.relative(root, current);
    // rel='' 表示已到 rootDir 本身——root 是 server 的同步根,永不修剪
    // 用 `..` + sep 判断越界,避免误伤 '..foo' 这类合法名字(用意同 sanitizePath)
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) break;

    try {
      fs.rmdirSync(current);
    } catch {
      break; // 非空或被占用:停在这里
    }
    current = path.dirname(current);
  }
}
