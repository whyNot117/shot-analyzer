// 视频帧与骨架帧的「硬绑定」（v5.10）：按屏幕上真正显示的那一帧取骨架
//
// 为什么要有这一层（v5.10）：旧实现用 requestAnimationFrame + video.currentTime
// 反推该画哪一帧骨架——currentTime 是「播放时钟」，可能比已经上屏的那一帧快一帧，
// 再叠加 Math.round 的四舍五入，人横向移动越快，骨架与真人就错得越明显
// （实测最快时偏差 2.4% 画幅，相当于 5–10 像素）。
//
// v5.10 的做法：扫描时用 requestVideoFrameCallback 记下每一帧真正上屏的时间戳
//（metadata.mediaTime），播放时同样用 rVFC 的 mediaTime 反查样本帧——
//「画面上这一帧」和「检测时采到的那一帧」用同一个时间轴对齐，不再靠猜。
//
// v5.10.1：取帧规则从「不晚于 mediaTime 的最后一个样本」改成「时间戳最接近 mediaTime 的样本」，
// 免得某个样本的时间戳差了毫秒级就整帧跳到前一帧（骨架画到前一帧的人身上）。

/**
 * 样本帧的排序键：优先用真正上屏的时间戳 pt，老数据（没有 pt）回退用采样时刻 t。
 */
function sortKey(frame) {
  const pt = frame?.pt;
  if (typeof pt === "number" && Number.isFinite(pt)) return pt;
  const t = frame?.t;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  return -Infinity;
}

/**
 * 取「时间戳最接近 mediaTime」的样本帧下标。
 *   · frames 为空 → -1
 *   · mediaTime 早于第一帧 → 0（画第一帧，至少不空）
 *   · mediaTime 晚于最后一帧 → frames.length - 1
 * 落在两个样本之间时取距离更近的那个；距离相同时取更早的那个。
 *
 * 为什么是「最接近」而不是「不晚于」（v5.10.1）：
 * 旧规则取「最后一个时间戳 <= mediaTime 的样本」，只要某个样本的时间戳偏晚一点点
 * （回退路径用名义采样时刻，会比真值晚约 1.7 毫秒），就会整帧跳到前一帧——
 * 画面上是第 k 帧，骨架画的是第 k-1 帧，人横向移动越快错得越明显。
 * 改成「最接近」之后：帧间隔约 33 毫秒，毫秒级的记录误差不足以选错帧；
 * 即使某一帧的时间戳有误差，也只会落在两个样本中间，不会跳到前一帧去。
 */
export function frameIndexAt(frames, mediaTime) {
  if (!Array.isArray(frames) || frames.length === 0) return -1;
  const target = typeof mediaTime === "number" && Number.isFinite(mediaTime) ? mediaTime : 0;
  // 二分找到第一个「时间戳 >= target」的样本下标（没有则停在末尾之外）
  let lo = 0;
  let hi = frames.length - 1;
  let idx = frames.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortKey(frames[mid]) < target) {
      lo = mid + 1;
    } else {
      idx = mid;
      hi = mid - 1;
    }
  }
  if (idx >= frames.length) return frames.length - 1; // 晚于最后一帧 → 最后一帧
  if (idx === 0) return 0;                             // 早于第一帧 → 第一帧
  // idx 与 idx-1 是目标两侧的邻居，比距离；相等时取更早的那个
  const distAfter = Math.abs(sortKey(frames[idx]) - target);
  const distBefore = Math.abs(sortKey(frames[idx - 1]) - target);
  return distAfter < distBefore ? idx : idx - 1;
}

/**
 * 浏览器是否支持 requestVideoFrameCallback（Chrome/Edge 支持，Safari 不支持）。
 * 不支持时退回 requestAnimationFrame + currentTime（旧行为，只是精度差一点）。
 */
export function supportsFrameCallback(el) {
  return !!el && typeof el.requestVideoFrameCallback === "function";
}
