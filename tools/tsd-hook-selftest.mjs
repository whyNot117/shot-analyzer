// pre-commit 钩子的自检脚本：验证检测器确实能拦住密文 blob。
//
// 用法：node tools/tsd-hook-selftest.mjs
// 它会在临时目录里造一个密文 blob，放进一份临时索引，然后跑检测器，
// 期望结果是「检测器报错并以非零码退出」。全程不碰真实索引、不提交任何东西。

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).stdout.trim();

const tmp = mkdtempSync(join(tmpdir(), "tsd-selftest-"));
const cipherPath = join(tmp, "cipher.bin");
const indexPath = join(tmp, "index");

function fail(message) {
  console.error(`[自检] 失败：${message}`);
  process.exit(1);
}

try {
  // 造一个和 DLP 容器一样头部的密文 blob。
  const magic = Buffer.from("%TSD-Header-###%", "ascii");
  const body = Buffer.alloc(4096 - magic.length);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 7 + 13) & 0xff;
  writeFileSync(cipherPath, Buffer.concat([magic, body]));

  const hash = spawnSync(
    "git",
    ["hash-object", "-w", "--stdin"],
    {
      cwd: repoRoot,
      input: Buffer.concat([magic, body]),
      maxBuffer: 1024 * 1024 * 1024,
    }
  );
  if (hash.status !== 0) fail("无法创建测试 blob。");
  const sha = hash.stdout.toString("utf8").trim();

  // 用临时索引复刻「README.md 已被密文替换后暂存」的状态。
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const readTree = spawnSync("git", ["read-tree", "HEAD"], {
    cwd: repoRoot,
    env,
  });
  if (readTree.status !== 0) fail("无法建立临时索引。");

  const update = spawnSync(
    "git",
    ["update-index", "--add", "--cacheinfo", `100644,${sha},README.md`],
    { cwd: repoRoot, env }
  );
  if (update.status !== 0) fail("无法写入临时索引。");

  // 期望：检测器识别出密文并以非零码退出。
  const check = spawnSync(
    process.execPath,
    [join(repoRoot, "tools", "check-tsd-encryption.mjs")],
    { cwd: repoRoot, env, encoding: "utf8" }
  );

  const out = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  console.log(out.trim());
  console.log("----------------------------------------");
  console.log(`[自检] 检测器退出码 = ${check.status}`);

  if (check.status === 0) {
    fail("检测器没有拦住密文 blob（退出码为 0），钩子形同虚设。");
  }
  if (!out.includes("%TSD-Header-###%") || !out.includes("README.md")) {
    fail("检测器虽然报错，但没有指出是 README.md 中招。");
  }

  // 反向对照：干净索引必须通过。
  const cleanEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "clean-index") };
  const readTree2 = spawnSync("git", ["read-tree", "HEAD"], {
    cwd: repoRoot,
    env: cleanEnv,
  });
  if (readTree2.status !== 0) fail("无法建立干净临时索引。");
  const clean = spawnSync(
    process.execPath,
    [join(repoRoot, "tools", "check-tsd-encryption.mjs")],
    { cwd: repoRoot, env: cleanEnv, encoding: "utf8" }
  );
  console.log(`[自检] 干净索引退出码 = ${clean.status}`);
  if (clean.status !== 0) fail("检测器误报了干净索引。");

  console.log("[自检] 全部通过：密文被拦下，干净内容放行。");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
