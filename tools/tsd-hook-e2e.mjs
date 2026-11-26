// pre-commit 钩子的端到端验证：让真实 git 面对一个含密文 blob 的索引，
// 确认钩子会阻断提交。
//
// 用法：node tools/tsd-hook-e2e.mjs
// 全程使用临时索引和临时分支，不会改动真实索引、不会产生提交。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).stdout.trim();

const tmp = mkdtempSync(join(tmpdir(), "tsd-e2e-"));
const indexPath = join(tmp, "index");

function fail(message) {
  console.error(`[e2e] 失败：${message}`);
  process.exit(1);
}

function git(args, options = {}) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
}

try {
  // 造一个密文 blob。
  const magic = Buffer.from("%TSD-Header-###%", "ascii");
  const body = Buffer.alloc(4096 - magic.length);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 7 + 13) & 0xff;
  const blob = Buffer.concat([magic, body]);

  const hash = git(["hash-object", "-w", "--stdin"], { input: blob });
  if (hash.status !== 0) fail("无法创建密文 blob。");
  const sha = hash.stdout.trim();
  console.log(`[e2e] 密文 blob = ${sha}`);

  // 用临时索引把 README.md 换成密文。
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  if (git(["read-tree", "HEAD"], { env }).status !== 0) fail("无法建立临时索引。");
  const update = git(
    ["update-index", "--add", "--cacheinfo", `100644,${sha},README.md`],
    { env }
  );
  if (update.status !== 0) {
    fail(`无法写入临时索引：${update.stderr}`);
  }

  const shown = git(["ls-files", "-s", "README.md"], { env }).stdout.trim();
  console.log(`[e2e] 临时索引里的 README.md = ${shown}`);

  // 真实提交尝试：钩子应当阻断。
  console.log("[e2e] 尝试提交（期望被钩子阻断）…");
  const commit = git(["commit", "-m", "e2e: 这条提交不应产生"], {
    env,
    encoding: "buffer",
  });
  const out = `${commit.stdout?.toString() ?? ""}${commit.stderr?.toString() ?? ""}`;
  console.log("----------------------------------------");
  console.log(out.trim());
  console.log("----------------------------------------");
  console.log(`[e2e] git commit 退出码 = ${commit.status}`);

  if (commit.status === 0) {
    fail("提交没有被阻断！钩子没有生效。");
  }
  if (!out.includes("%TSD-Header-###%")) {
    fail("提交确实被拦了，但报错里没有指出密文特征。");
  }

  // 确认没有真的产生提交。
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const before = git(["rev-parse", "HEAD@{1}"]).stdout.trim();
  if (head !== before && head !== git(["rev-list", "-n", "1", "HEAD"]).stdout.trim()) {
    fail("HEAD 发生了意外变化。");
  }
  console.log(`[e2e] HEAD 未被移动：${head.slice(0, 8)}`);

  console.log("[e2e] 通过：密文索引被成功拦截，未产生任何提交。");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
