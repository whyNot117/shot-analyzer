// v5.10 帧级硬绑定测试：frameIndexAt 的取帧规则（v5.10.1：取「最接近」的样本帧）
// 运行：node test/sync-test.mjs
//
// 这一层是「骨架和人对齐」的地基：叠加层必须按屏幕上真正显示的那一帧
// （rVFC 的 mediaTime）去查样本帧，查错一帧，人一动骨架就错位。
import { frameIndexAt, supportsFrameCallback } from "../js/sync.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? " —— " + detail : ""}`);
  }
};

console.log("== frameIndexAt：空数组 ==");
check("空数组返回 -1", frameIndexAt([], 1.0) === -1);
check("非数组返回 -1", frameIndexAt(null, 1.0) === -1 && frameIndexAt(undefined, 0) === -1);

console.log("== frameIndexAt：早于第一帧 ==");
{
  const frames = [
    { t: 1.0, pt: 1.02 },
    { t: 1.1, pt: 1.11 },
  ];
  check("媒体时间早于第一帧 → 取第 0 帧", frameIndexAt(frames, 0.5) === 0, `得到 ${frameIndexAt(frames, 0.5)}`);
  check("媒体时间正好等于第一帧 → 取第 0 帧", frameIndexAt(frames, 1.02) === 0);
}

console.log("== frameIndexAt：正好命中 ==");
{
  const frames = [
    { t: 0, pt: 0 },
    { t: 0.1, pt: 0.105 },
    { t: 0.2, pt: 0.2 },
  ];
  check("命中第 1 帧", frameIndexAt(frames, 0.105) === 1, `得到 ${frameIndexAt(frames, 0.105)}`);
  check("命中第 2 帧", frameIndexAt(frames, 0.2) === 2, `得到 ${frameIndexAt(frames, 0.2)}`);
  check("浮点误差（0.2 - 1e-9）也算命中", frameIndexAt(frames, 0.2 - 1e-9) === 2);
}

console.log("== frameIndexAt：落在两个样本之间（取最接近的那个）==");
{
  const frames = [
    { t: 0, pt: 0 },
    { t: 0.1, pt: 0.1 },
    { t: 0.2, pt: 0.2 },
  ];
  check("0.14 → 更靠近第 1 帧", frameIndexAt(frames, 0.14) === 1, `得到 ${frameIndexAt(frames, 0.14)}`);
  check("0.16 → 更靠近第 2 帧", frameIndexAt(frames, 0.16) === 2, `得到 ${frameIndexAt(frames, 0.16)}`);
  check("0.15 → 距离相同，取更早的第 1 帧", frameIndexAt(frames, 0.15) === 1, `得到 ${frameIndexAt(frames, 0.15)}`);
  check("0.199 → 更靠近第 2 帧", frameIndexAt(frames, 0.199) === 2, `得到 ${frameIndexAt(frames, 0.199)}`);
  check("0.099 → 更靠近第 1 帧", frameIndexAt(frames, 0.099) === 1, `得到 ${frameIndexAt(frames, 0.099)}`);
  check("0.001 → 更靠近第 0 帧", frameIndexAt(frames, 0.001) === 0, `得到 ${frameIndexAt(frames, 0.001)}`);
}

console.log("== frameIndexAt：毫秒级误差不会跳到前一帧（v5.10.1）==");
{
  // 回退路径记下来的 pt 会比真值晚约 1.7 毫秒；
  // 旧规则（「不晚于就取它」）会把这一帧错判成前一帧。
  const frames = [
    { t: 0, pt: 0 },
    { t: 0.1, pt: 0.1 },
    { t: 0.2, pt: 0.2 },
  ];
  check("目标比第 2 帧早 1.7 毫秒 → 仍是第 2 帧", frameIndexAt(frames, 0.2 - 0.0017) === 2,
    `得到 ${frameIndexAt(frames, 0.2 - 0.0017)}`);
  check("目标比第 2 帧早 1.7 毫秒（t 侧）→ 仍是第 2 帧", frameIndexAt(frames, 0.1983) === 2,
    `得到 ${frameIndexAt(frames, 0.1983)}`);
}

console.log("== frameIndexAt：晚于最后一帧 ==");
{
  const frames = [
    { t: 0, pt: 0 },
    { t: 0.1, pt: 0.1 },
  ];
  check("超出末尾 → 取最后一帧", frameIndexAt(frames, 99) === 1, `得到 ${frameIndexAt(frames, 99)}`);
  check("刚好在最后一帧之后一点 → 仍是最后一帧", frameIndexAt(frames, 0.1001) === 1);
}

console.log("== frameIndexAt：pt 缺失回退用 t ==");
{
  const frames = [
    { t: 0 },
    { t: 0.1, pt: null },
    { t: 0.2 },
  ];
  check("无 pt 的老数据按 t 排序取帧", frameIndexAt(frames, 0.14) === 1, `得到 ${frameIndexAt(frames, 0.14)}`);
  check("无 pt 的老数据取最接近的帧", frameIndexAt(frames, 0.16) === 2, `得到 ${frameIndexAt(frames, 0.16)}`);
  check("全部无 pt 时同样按 t 取", frameIndexAt(frames, 0.05) === 0);
  check("全部无 pt 时命中末尾", frameIndexAt(frames, 0.2) === 2);
}

console.log("== frameIndexAt：pt 与 t 混用（部分帧有 pt）==");
{
  const frames = [
    { t: 0, pt: 0.01 },
    { t: 0.1, pt: null },
    { t: 0.2, pt: 0.21 },
  ];
  check("按 pt/t 混合键取最接近的", frameIndexAt(frames, 0.15) === 1, `得到 ${frameIndexAt(frames, 0.15)}`);
  check("按 pt/t 混合键取最接近的（靠近末帧）", frameIndexAt(frames, 0.16) === 2, `得到 ${frameIndexAt(frames, 0.16)}`);
  check("晚于最后一帧 → 最后一帧", frameIndexAt(frames, 5) === 2);
}

console.log("== supportsFrameCallback ==");
check("没有 requestVideoFrameCallback → false", supportsFrameCallback({}) === false);
check("null → false", supportsFrameCallback(null) === false);
check("有 requestVideoFrameCallback → true", supportsFrameCallback({ requestVideoFrameCallback() {} }) === true);

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
