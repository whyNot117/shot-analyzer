#!/usr/bin/env node
// 检测 Git 索引中的 blob 是否被本机 DLP 加密驱动（TsdEncrypt）写成密文容器。
//
// 背景：本机装有 TEC Solutions 的 TsdEncrypt/TsdEncryptMF 文件系统过滤驱动，
// 它会把部分文件以加密容器形式落盘，magic 为 "%TSD-Header-###%"（16 字节），
// 总长度对齐到 4096 的倍数。git 在 add 阶段有时读到的是密文而非明文，
// 于是密文被提交进仓库，GitHub Pages 的 Jekyll 构建直接失败。
//
// 用法：
//   node tools/check-tsd-encryption.mjs            检查索引（提交时真正会入库的内容）
//   node tools/check-tsd-encryption.mjs --worktree 额外扫描工作区文件
//   node tools/check-tsd-encryption.mjs --all       扫描全部历史 blob（慢，仅排查用）
//
// 退出码：0 = 干净；1 = 发现密文 blob；2 = 执行出错。

import { spawnSync } from "node:child_process";
import { openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TSD_MAGIC = "%TSD-Header-###%";
const MAGIC_LEN = TSD_MAGIC.length;

// 单个 blob 超过此大小就不整块读入内存。
const INLINE_MAX_BYTES = 4 * 1024 * 1024;
// 一次批量读取的总字节上限，超过则只检查小文件。
const TOTAL_MAX_BYTES = 512 * 1024 * 1024;

const repoRoot = findRepoRoot();

function findRepoRoot() {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("[TSD 检查] 无法确定 Git 仓库根目录，请在该仓库内运行。");
    process.exit(2);
  }
  return res.stdout.trim();
}

function git(args, options = {}) {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
  if (res.status !== 0) {
    const err = res.stderr ? res.stderr.toString() : "";
    console.error(`[TSD 检查] git ${args.join(" ")} 执行失败：\n${err}`);
    process.exit(2);
  }
  return res.stdout;
}

// 读取索引条目：<mode> SP <sha> SP <stage> TAB <path> NUL
function readIndexEntries() {
  const out = git(["ls-files", "-s", "-z"], { encoding: "buffer" });
  const entries = [];
  let start = 0;
  while (start < out.length) {
    const end = out.indexOf(0, start);
    if (end === -1) break;
    const record = out.toString("utf8", start, end);
    const tab = record.indexOf("\t");
    if (tab !== -1) {
      const meta = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (meta[1]) entries.push({ sha: meta[1], path });
    }
    start = end + 1;
  }
  return entries;
}

function blobSizes(shas) {
  const res = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: repoRoot,
    input: shas.join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const out = new Map();
  const lines = res.stdout.toString("utf8").split("\n");
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length >= 3 && parts[1] === "blob") {
      out.set(parts[0], parseInt(parts[2], 10));
    }
  }
  return out;
}

// 一次性批量取回 blob 头部，避免逐个开进程。
function readBlobMagics(shas) {
  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: shas.join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error("[TSD 检查] git cat-file --batch 执行失败。");
    process.exit(2);
  }
  const buf = res.stdout;
  const out = new Map();
  let off = 0;
  for (const sha of shas) {
    const nl = buf.indexOf(10, off);
    if (nl === -1) break;
    const header = buf.toString("ascii", off, nl).split(" ");
    const size = parseInt(header[2], 10);
    if (!Number.isFinite(size)) {
      off = nl + 1;
      continue;
    }
    out.set(sha, buf.toString("ascii", nl + 1, nl + 1 + MAGIC_LEN));
    off = nl + 1 + size + 1;
  }
  return out;
}

function checkIndex(entries) {
  const sizes = blobSizes(entries.map((e) => e.sha));
  let total = 0;
  for (const entry of entries) total += sizes.get(entry.sha) ?? 0;

  const inline = [];
  if (total <= TOTAL_MAX_BYTES) {
    inline.push(...entries);
  } else {
    for (const entry of entries) {
      if ((sizes.get(entry.sha) ?? 0) <= INLINE_MAX_BYTES) inline.push(entry);
    }
    console.warn(
      `[TSD 检查] 索引总大小 ${total} 字节超过上限，仅检查 ${inline.length}/${entries.length} 个文件。`
    );
  }

  const magics = readBlobMagics(inline.map((e) => e.sha));
  const hits = [];
  for (const entry of inline) {
    if (magics.get(entry.sha) === TSD_MAGIC) hits.push(entry);
  }
  return hits;
}

function scanWorktree() {
  const hits = [];
  const stack = [repoRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const fd = openSync(full, "r");
        const buf = Buffer.alloc(MAGIC_LEN);
        const n = readSync(fd, buf, 0, MAGIC_LEN, 0);
        closeSync(fd);
        if (n === MAGIC_LEN && buf.toString("ascii") === TSD_MAGIC) {
          hits.push({ path: relative(repoRoot, full), sha: "" });
        }
      } catch {
        // 无权限或被占用，跳过。
      }
    }
  }
  return hits;
}

function checkHistory() {
  const entries = [];
  for (const line of git(["rev-list", "--objects", "--all"]).split("\n")) {
    const tab = line.indexOf(" ");
    if (tab === -1) continue;
    entries.push({ sha: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  const magics = readBlobMagics(entries.map((e) => e.sha));
  const hits = [];
  for (const entry of entries) {
    if (magics.get(entry.sha) === TSD_MAGIC) hits.push(entry);
  }
  return hits;
}

function report(hits, scope) {
  if (hits.length === 0) {
    console.log(`[TSD 检查] ${scope}：未发现加密 blob。`);
    return;
  }
  console.error(`\n[TSD 检查] ${scope}：发现 ${hits.length} 个被 DLP 加密的 blob！\n`);
  for (const hit of hits) {
    console.error(`  ${hit.path}${hit.sha ? `  (${hit.sha})` : ""}`);
  }
  console.error(
    [
      "",
      "这些是密文容器（%TSD-Header-###%），不是明文。提交它们会导致：",
      "  · GitHub Pages 的 Jekyll 构建失败（build 红、deploy 跳过）",
      "  · 站点在浏览器里加载到二进制乱码",
      "",
      "处理办法：",
      "  1. 用解密后的明文重新写入该文件（可从上一次成功提交恢复，或手工重建），",
      "  2. git add 该文件，确认文件头不再是 %TSD-Header-###%，",
      "  3. 重新提交。",
      "",
      "根治办法：请 IT 把本仓库目录加入 DLP 加密策略的排除名单。",
      "",
    ].join("\n")
  );
}

const args = process.argv.slice(2);
const wantWorktree = args.includes("--worktree");
const wantAll = args.includes("--all");

let failed = false;

if (wantAll) {
  report(checkHistory(), "全部历史 blob");
  failed = true;
} else {
  const entries = readIndexEntries();
  const hits = checkIndex(entries);
  report(hits, `索引（${entries.length} 个文件）`);
  failed = hits.length > 0;

  if (wantWorktree) {
    const wtHits = scanWorktree();
    report(wtHits, "工作区文件");
    failed = failed || wtHits.length > 0;
  }
}

if (failed) process.exit(1);
process.exit(0);
