#!/usr/bin/env node
// json-deep-merge.js — repo config 为基准，保留本地额外字段
// Usage: node json-deep-merge.js <repo.json> <local.json>
// 输出合并后的 JSON 到 stdout
// 规则：
//   - repo 中的 key 总是覆盖 local（repo 是权威源）
//   - local 中有但 repo 中没有的 key 保留（gateway 写入的字段）
//   - 以 _ 开头的 key 视为临时字段，不保留

const fs = require('fs');

function deepMerge(repo, local) {
  if (repo === null || repo === undefined) return repo;
  if (typeof repo !== 'object' || Array.isArray(repo)) return repo;
  if (typeof local !== 'object' || Array.isArray(local) || local === null) return repo;

  const result = {};

  // 先保留 local 中的额外字段（repo 没有的）
  for (const key of Object.keys(local)) {
    if (key.startsWith('_')) continue; // 跳过临时字段
    if (!(key in repo)) {
      result[key] = local[key];
    }
  }

  // repo 的 key 优先，递归合并 object 类型
  for (const key of Object.keys(repo)) {
    if (
      typeof repo[key] === 'object' &&
      repo[key] !== null &&
      !Array.isArray(repo[key]) &&
      typeof local[key] === 'object' &&
      local[key] !== null &&
      !Array.isArray(local[key])
    ) {
      result[key] = deepMerge(repo[key], local[key]);
    } else {
      result[key] = repo[key];
    }
  }

  return result;
}

const [repoPath, localPath] = process.argv.slice(2);
if (!repoPath || !localPath) {
  console.error('Usage: node json-deep-merge.js <repo.json> <local.json>');
  process.exit(1);
}

try {
  const repo = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const merged = deepMerge(repo, local);
  console.log(JSON.stringify(merged, null, 2));
} catch (e) {
  console.error('Merge failed:', e.message);
  process.exit(1);
}
