// 媒体文件辅助（纯函数，可在 Node 里测试）
// 微信等渠道的高清视频常用 HEVC(H.265) 编码，部分浏览器/系统缺解码器无法播放，
// 上传失败时嗅探文件头部的编码四字符码，命中就给出可执行的解决办法而不是让用户干等。

const HEVC_FOURCC = ["hvc1", "hev1", "dvh1"]; // HEVC 的编码标签；H.264 是 avc1
const SNIFF_BYTES = 2 * 1024 * 1024; // mp4 的 moov 元数据可能在头部也可能靠后，多读一点

/** 判断媒体文件是否为 HEVC(H.265) 编码（读不到/判断不了时返回 false） */
export async function isHevcFile(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    let text = "";
    for (let i = 0; i < buf.length; i += 32768) {
      text += String.fromCharCode(...buf.subarray(i, i + 32768));
    }
    return HEVC_FOURCC.some((cc) => text.includes(cc));
  } catch {
    return false;
  }
}

// ---------- 多人同框：锁定主人公 ----------
// 设计原则（经四轮对抗审查迭代，两条核心教训：①「更大的路人中途夺锁」必被透视体型差
// （半步远近 ≈1.1–1.5×）击穿；②只看位置的匹配会让站在主人公原位的替身无缝继承锁）：
// ① 身份 = 位置 + 体型双因子：距锁定点 ≤0.2 且体积在持锁者「站高记忆」的 0.55–1.6 倍内
//    才算匹配——更大的队友贴站、主人公蹲下塌缩（深蹲约塌到站高 72–78%）都不动摇；
// ② 体积记忆取近期最大值、只缓慢衰减（站高基准，蹲起不拉低）；
// ③ 匹配不上（被遮挡/出画/替身体型不符）→ 冻结锁点返回 null 等回归，不把锁交给别人；
// ④ 冻结超时（主人公真走了）→ 重置基准按「占画面最大」重锁；
// ⑤ ghost 认回：在冻结起点、换锁时刻、持锁者体型单帧跳升 >1.15× 三处记下被顶下者的
//    「位置+体型」印象；此后有人回到印象位置且体型在 0.75–1.8× 内，即换回与印象体型
//    最接近者（≤1.1× 印象的认回视为确系原主并清印象；更大者接锁不清，原主仍可夺回）。
//    已知极限：a) 体型带内（0.55–1.6×）的替身无缝继承锁时无冻结无换锁，印象无从记录，
//    原主回归敌不过现任的平局裁决——2D 骨架无外观特征，物理不可分；
//    b) 快速远去（≥45%/s）断链点远离原位时，印象位置同样失效；
// ⑥ 体积只统计可见度达标的关键点（半身路人被外推的「看不见的肢体」不能撑大体积）。
const VIS_MIN = 0.3; // 关键点可见度低于此值视为不可信（坐标是外推值，不能当体积依据）
const MATCH_DIST = 0.2; // 候选躯干中心距锁定点 ≤ 此值才可能是「持锁者本人」
const MATCH_LO = 0.55; // 匹配体积下限（×站高记忆）：挡替身，深蹲塌缩（≥0.72）仍能通过
const MATCH_HI = 1.6; // 匹配体积上限（×站高记忆）：挡更近镜头的更大替身
const HOLD_MAX = 150; // 匹配不上时冻结等待的最多帧数（约 5s @30fps），超时重置基准
const SWITCH_RATIO = 1.8; // 候选 > 站高记忆×此倍数才允许换锁（透视半步体型差约 1.1–1.5×）
const REAL_MIN = 0.15; // 多人统计只算占画面 ≥15% 高度的姿态（幽灵/NaN 检测不算人）

export function makePersonPicker() {
  let lock = null; // { x, y, size }：持锁者躯干中心 EMA + 站高体积记忆
  let ghost = null; // 被顶下者的「位置+体型」印象（冻结起点/换锁时刻/体型跳升三处记录）
  let lost = 0, lastSize = 0;
  let maxSeen = 1;

  const pick = (poses) => {
    const info = [];
    for (const lm of poses ?? []) {
      if (!Array.isArray(lm)) continue; // 稀疏数组/空槽防御：undefined 姿态整条剔除
      // 躯干中心（双肩+双髋平均）；任一坐标非有限则整个姿态不可信，整条剔除
      // （NaN 会毒化 hypot 与 EMA，之后所有距离比较恒 false，跟踪器退化成「永远取第一个」）
      const core = [lm[11], lm[12], lm[23], lm[24]];
      if (core.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
      const cx = (core[0].x + core[1].x + core[2].x + core[3].x) / 4;
      const cy = (core[0].y + core[1].y + core[2].y + core[3].y) / 4;
      // 体积 = 头/肩最高点到踝/膝最低点；只统计可见点，全不可见记 0（不参与「最大」竞争）
      const ok = (p) => p && Number.isFinite(p.y) && (p.visibility ?? 1) >= VIS_MIN;
      const tops = [lm[0], lm[11], lm[12]].filter(ok).map((p) => p.y);
      const bots = [lm[27], lm[28], lm[25], lm[26]].filter(ok).map((p) => p.y);
      const size = tops.length && bots.length ? Math.max(0.01, Math.max(...bots) - Math.min(...tops)) : 0;
      info.push({ lm, cx, cy, size });
    }
    // 多人提示只统计「可信且像真人」的姿态，避免单人视频被幽灵/NaN 检测误报成多人
    maxSeen = Math.max(maxSeen, Math.max(1, info.filter((p) => p.size >= REAL_MIN).length));
    if (!info.length) return null; // 本帧无可信姿态：不动 lock，该帧由上层插值

    const bySize = (a, b) => (b.size > a.size ? b : a);
    // 认回原主：锁点被替身/队友接管后（超时重锁，或冻结期间回归），若有人回到主人公
    // 消失前的位置且体型在印象的 0.75–1.8 倍内，换回其中体型与印象最接近者。
    // 离场取球 5 秒被替身接管是常见场景；印象一经认回即清除，未认回则长期保留
    // （替身匹配不清印象——那是找回原主的唯一线索）
    if (ghost) {
      let best = null, bestScore = Infinity;
      for (const p of info) {
        if (Math.hypot(p.cx - ghost.x, p.cy - ghost.y) > MATCH_DIST) continue;
        if (p.size < ghost.size * 0.75 || p.size > ghost.size * MATCH_HI) continue; // 上限与匹配带一致：ghost 不得比匹配带更宽
        const score = Math.abs(Math.log(p.size / ghost.size));
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) {
        // 认回者与印象体型相称（≤1.1×）→ 确系原主，印象清除；明显更大的接锁者
        // （换锁巨人 / 检测器突然看清全身）不清印象——原主回归时仍可凭更低偏差夺回
        const gSize = ghost.size;
        if (best.size <= gSize * 1.1) ghost = null;
        lock = { x: best.cx, y: best.cy, size: Math.max(best.size, gSize) };
        lost = 0;
        return best.lm;
      }
    }
    // 换锁通道（记忆衰减后更大的真实主 / 首帧误锁自纠）：候选远超站高记忆才放行；
    // 换锁时刻记下被顶下者的印象，给原主留认回通道。印象 = 最近一次被顶下的持锁者
    // （??= 保留更早的印象）；首帧误锁自纠时记录的就是误锁者本身——那时还没有真原主
    if (lock) {
      const big = info.reduce(bySize);
      if (big.size > lock.size * SWITCH_RATIO) {
        ghost ??= { ...lock };
        lock = { x: big.cx, y: big.cy, size: big.size };
        lost = 0;
        return big.lm;
      }
    }
    const d = (p) => Math.hypot(p.cx - lock.x, p.cy - lock.y);
    let chosen, snap = false;
    if (!lock) { chosen = info.reduce(bySize); snap = true; } // 首帧：占画面最大者
    else {
      const matched = info.filter((p) =>
        d(p) <= MATCH_DIST && p.size >= lock.size * MATCH_LO && p.size <= lock.size * MATCH_HI);
      if (matched.length) {
        lost = 0;
        chosen = matched.reduce((a, b) => (d(b) < d(a) ? b : a));
      } else if (++lost <= HOLD_MAX) {
        ghost ??= { ...lock }; // 冻结起点快照：主人公消失前的位置与体型
        return null; // 遮挡/出画/替身体型不符：冻结锁点等回归
      }
      else { chosen = info.reduce(bySize); snap = true; lost = 0; } // 超时：重置基准重锁（ghost 保留以认回原主）
    }
    // 体型单帧跳升 >1.15×：更大的家伙顶进了锁定点（蹲持期被队友顶替），或检测器
    // 突然看清全身——都记下跳升前的印象，给原主留认回通道（缓变不触发）
    if (!snap && lastSize > 0 && chosen.size > lastSize * 1.15) ghost ??= { ...lock };
    lastSize = chosen.size;
    lock = snap
      ? { x: chosen.cx, y: chosen.cy, size: chosen.size }
      : { x: lock.x * 0.7 + chosen.cx * 0.3, y: lock.y * 0.7 + chosen.cy * 0.3,
          size: Math.max(chosen.size, lock.size * 0.99) }; // 站高记忆：取大、缓慢衰减
    return chosen.lm;
  };

  return { pick, get peopleSeen() { return maxSeen; } };
}
