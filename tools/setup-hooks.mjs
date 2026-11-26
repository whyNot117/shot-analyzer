// 一键安装 pre-commit 拦截钩子。
//
// core.hooksPath 是**本地配置**，不随仓库分发：别人 clone 下来不会自动带上钩子。
// 这个脚本负责把钩子目录挂上，并做一次自检，确保装完真的生效。
//
// 用法：node tools/setup-hooks.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = "tools/hooks";
const HOOK_FILE = "tools/hooks/pre-commit";

const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).stdout.trim();

if (!repoRoot) {
  console.error("[钩子安装] 当前目录不是 Git 仓库。");
  process.exit(2);
}

function git(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function fail(message) {
  console.error(`[钩子安装] 失败：${message}`);
  process.exit(1);
}

const hookPath = join(repoRoot, HOOK_FILE);
if (!existsSync(hookPath)) {
  fail(`找不到 ${HOOK_FILE}，仓库可能不完整。`);
}

// 钩子是 shell 脚本，被转成 CRLF 会让 sh 拒绝执行，先确认行尾。
const raw = readFileSync(hookPath);
if (raw.includes(0x0d)) {
  fail(
    `${HOOK_FILE} 含有 CRLF 行尾，sh 会拒绝执行。\n` +
      "  修复：git checkout -- tools/hooks/pre-commit"
  );
}
if (!raw.toString("utf8").startsWith("#!/bin/sh\n")) {
  fail(`${HOOK_FILE} 的 shebang 不正确。`);
}

// 挂上钩子目录。
const set = git(["config", "core.hooksPath", HOOKS_DIR]);
if (set.status !== 0) {
  fail(`写入 core.hooksPath 失败：${set.stderr}`);
}

// Windows 上 core.fileMode 常为 false，索引里的可执行位需要显式补上，
// 否则别人 clone 下来钩子不会被执行。
const chmod = git(["update-index", "--chmod=+x", HOOK_FILE]);
if (chmod.status !== 0) {
  console.warn(
    `[钩子安装] 警告：无法设置 ${HOOK_FILE} 的可执行位（${chmod.stderr.trim()}）。`
  );
}

// 自检：确认 git 认可这个钩子路径，且检测器本身工作正常。
const effective = git(["config", "--get", "core.hooksPath"]).stdout.trim();
if (effective !== HOOKS_DIR) {
  fail(`core.hooksPath 生效值异常：${effective || "(空)"}`);
}

const check = spawnSync(
  process.execPath,
  [join(repoRoot, "tools", "check-tsd-encryption.mjs")],
  { cwd: repoRoot, encoding: "utf8" }
);
if (check.status !== 0) {
  console.error((check.stdout ?? "") + (check.stderr ?? ""));
  fail("密文检测器在当前索引上报错，请先处理上面列出的文件。");
}

console.log("[钩子安装] 完成。");
console.log(`  core.hooksPath = ${effective}`);
console.log(`  钩子文件        = ${HOOK_FILE}`);
console.log("  提交时若检测到 DLP 密文，提交会被直接拒绝。");
console.log("  自检命令        = npm run test:tsd");
