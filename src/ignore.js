// src/ignore.js
// Shared .gitignore matching for client and server. Both sides must agree:
// the client filters its scan (push/diff) while the server filters its list,
// so a rule that only one side understands silently diverges the inventories.
import { Minimatch } from 'minimatch';

// minimatch() compiles the pattern on every call. A large tree tests the same
// handful of rules against thousands of paths, so cache the compiled matchers.
const compiledCache = new Map();
const COMPILED_CACHE_MAX = 10000;

function compiledMatch(filepath, pattern) {
  let matcher = compiledCache.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, { dot: true });
    if (compiledCache.size >= COMPILED_CACHE_MAX) compiledCache.clear();
    compiledCache.set(pattern, matcher);
  }
  return matcher.match(filepath);
}

export function parseGitignore(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

export function shouldIgnore(filepath, rules) {
  let ignored = false;
  for (const rule of rules) {
    // Negation rules (!) un-ignore on match; the last matching rule wins.
    if (rule.startsWith('!')) {
      if (matchesPattern(filepath, rule.slice(1))) ignored = false;
      continue;
    }
    if (matchesPattern(filepath, rule)) ignored = true;
  }
  return ignored;
}

export function matchesPattern(filepath, pattern) {
  // Git anchors a rule at the sync root only when it starts with "/".
  // Strip the marker so the rest is matched root-relative.
  const anchored = pattern.startsWith('/');
  const raw = anchored ? pattern.slice(1) : pattern;
  if (!raw) return false;

  // "dir/" is a directory rule: match the directory and everything below it.
  const body = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (!body) return false;

  // Unanchored rules keep matching at any depth ("**/"); anchored rules must
  // not get that fallback -- matching "/rss/*" as "**/rss/*" is what made a
  // nested routes/rss/ file disappear from push and diff.
  const candidates = anchored ? [body] : [body, '**/' + body];
  for (const candidate of candidates) {
    if (compiledMatch(filepath, candidate)) return true;
    // Matching a directory implies its contents are ignored as well.
    if (compiledMatch(filepath, candidate + '/**')) return true;
  }
  return false;
}