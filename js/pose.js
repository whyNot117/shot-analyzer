// MediaPipe Pose Landmarker 封装：懒加载模型，提供推理时间戳。
// 模型与 WASM 运行时已内置在站内（model/ 与 vendor/，共约 25MB）——
// 不再依赖 jsdelivr / googleapis CDN：国内手机网络连不上国外 CDN 时照常工作，
// 首次访问后由 Service Worker 缓存，离线可用。

const VENDOR = new URL("../vendor/tasks-vision.mjs", import.meta.url).href;
const WASM_BASE = new URL("../vendor/wasm", import.meta.url).href;
const MODEL = new URL("../model/pose_landmarker_lite.task", import.meta.url).href;

let landmarkerPromise = null;
let forceCpu = false; // GPU 连续失败后置位：重建时不再尝试 GPU

export function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(VENDOR);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      const make = (delegate) =>
        vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO",
          numPoses: 3, // 多人同框时由上层锁定主人公；单人视频也兼容，速度略降一两成
        });
      if (forceCpu) return make("CPU");
      try {
        return await make("GPU"); // 手机上 GPU 明显更快
      } catch {
        return await make("CPU"); // WebGL 不可用时退回 CPU
      }
    })();
  }
  return landmarkerPromise;
}

/** GPU 推理连续失败（WebGL 上下文丢失等）时调用：关闭旧实例并重建，之后固定走 CPU */
export async function resetLandmarker() {
  forceCpu = true;
  const old = landmarkerPromise;
  landmarkerPromise = null;
  try {
    (await old)?.close?.();
  } catch { /* 旧实例可能已不可用 */ }
  return getLandmarker();
}

// detectForVideo 要求时间戳严格递增，全局维护一个计数器（约 30fps 间隔）
let tsCounter = 0;

export function nextTimestamp() {
  tsCounter += 33.34;
  return tsCounter;
}

/** 每次扫描前调用：重置 VIDEO 模式的时序跟踪状态——否则第二次扫描带着上一次
 *  结束帧的平滑/跟踪状态起步，逐帧关键点与首次不同（同视频两次评分漂移的根因之一）。
 *  reset 成功后时间戳从 0 重启（API 只要求严格递增，图状态清零后合法） */
export function beginScan(landmarker) {
  let ok = false;
  try {
    if (typeof landmarker?.reset === "function") {
      landmarker.reset();
      ok = true;
    }
  } catch { /* 旧版本无 reset 或状态异常：退回沿用现有状态 */ }
  if (ok) tsCounter = 0;
  return ok;
}
