// 等待屏幕变化：在工具内部高频抽帧轮询，一检测到变化就立刻返回，
// 让模型不必因为「页面还没加载完」而反复盲调 vp_screenshot_diff。
//
// 轮询期间的成本全在内存里，这是本文件存在的唯一理由。实测（1920x1200，本机）：
//   单帧 81~125ms（屏安静时，中位 84ms）／214~242ms（屏上有大片差异，连通块更贵），
//   拆开看 captureMonitor 45~54ms / toBuffer 2.4ms / pixelmatch 4.5~30ms / 连通块 12~15ms；
//   而 savePng 126~142ms、PNG.sync.read 47~56ms —— 落盘比截屏本身贵近 3 倍。
// 所以轮询只碰 toBuffer()，一次落盘都不做；只有确认变化、退出循环的那一帧
// 才走 screenshotAction() 落盘写索引，并基于那张「正式」截图生成局部裁剪图。
//
// 呼吸阀：连续没有变化时逐步降频（100ms → 200ms → 500ms），
// 减少底层截屏句柄的申请频率，给系统沙箱/ACL 压力留出余量。
//
// 静默期：第一帧变化往往只是「渲染中途」——逐字输出、页面骨架先出内容后填。
// 所以检出变化后不立刻交还控制权，而是再按 100ms 节奏观察，连续 3 次没有新的
// 实质变化（约 300ms）才认为渲染稳定；期间又变了就重置计时。最多观察 2 秒，
// 画面一直在变也会强行返回，避免拖死调用方（返回 settled=false）。
//
// 边界：只有主屏全屏；可选 region 只观察局部区域（区域外变化彻底忽略）；
// 不做多显示器、不缓存历史帧。
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { loadRobotTs } from './robot-ts.js'
import { get, assertShotFileExists } from './shot-index.js'
import { checkCanClick, getAuthEpoch } from './auth.js'
import { screenshotAction } from './actions.js'
import { diffPair, connectedComponents, crop, normalizeRegion, DEFAULT_MIN_REGION_AREA } from './diff.js'

export const DEFAULT_POLL_INTERVAL_MS = 100
export const DEFAULT_TIMEOUT_MS = 3000
// 工具参数由模型给，不设上限就等于让它自己挑一个能挂住宿主的等待时长。
export const MAX_TIMEOUT_MS = 30000
// 过滤噪声后的差异像素占被比对区域（默认整屏，region 模式下为 region）
// 比例超过它才算「变了」。光标/插入符闪烁约 400 像素 ≈ 1.7e-4，取一个数量级余量。
export const DEFAULT_MIN_COVERAGE = 0.001

// 呼吸阀档位（从开始等待算起的连续未变化时长）。
export const BACKOFF_STEP_1_AFTER_MS = 1000
export const BACKOFF_STEP_1_INTERVAL_MS = 200
export const BACKOFF_STEP_2_AFTER_MS = 2000
export const BACKOFF_STEP_2_INTERVAL_MS = 500

// 静默期档位：检出变化后的稳定确认节奏。
export const QUIET_CHECK_INTERVAL_MS = 100
export const QUIET_STABLE_CHECKS = 3
export const QUIET_MAX_WAIT_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 动态降频：初始 baseIntervalMs，连续 1 秒没变化放宽到 200ms，
 * 超过 2 秒没变化放宽到 500ms。档位是绝对值，与 base 无关。
 */
export function resolvePollInterval(waitedMs, baseIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
  if (waitedMs >= BACKOFF_STEP_2_AFTER_MS) return BACKOFF_STEP_2_INTERVAL_MS
  if (waitedMs >= BACKOFF_STEP_1_AFTER_MS) return BACKOFF_STEP_1_INTERVAL_MS
  return baseIntervalMs
}

function readPng(path) {
  return PNG.sync.read(readFileSync(path))
}

/**
 * 过滤噪声后的变化像素数：与 diffPair 用同一套判据（pixelmatch 的抗锯齿过滤 +
 * 连通块面积下限），否则轮询说「变了」而落盘那张说「没变」，返回值就自相矛盾了。
 */
function changedPixels(mask, width, height, minArea) {
  let sum = 0
  for (const component of connectedComponents(mask, width, height)) {
    if (component.pixels >= minArea) sum += component.pixels
  }
  return sum
}

/**
 * 静默期：变化确认后再观察，等界面真正渲染稳定。
 * 每 checkIntervalMs 抓一帧，与「最后一次观测到新变化的参考帧」比对：
 *   - 出现新的实质变化（过滤噪声后 >0 像素）→ 计数清零，参考帧换成新帧；
 *   - 连续 stableChecks 次没有再变 → settled=true 返回；
 *   - 总时长达到 maxWaitMs → settled=false 强行返回（画面一直在变，不能拖死调用方）。
 * capture 由调用方注入（生产是截屏 + region 裁剪，测试是脚本化帧序列），
 * 判定标准与 diffPair 完全一致（同一 threshold 与连通块噪声下限），
 * 避免「静默期说稳了、落盘那张说还在变」的自相矛盾。
 */
export async function settleQuiet({
  reference,
  capture,
  width,
  height,
  threshold = 0.1,
  minArea = DEFAULT_MIN_REGION_AREA,
  checkIntervalMs = QUIET_CHECK_INTERVAL_MS,
  stableChecks = QUIET_STABLE_CHECKS,
  maxWaitMs = QUIET_MAX_WAIT_MS,
  onTick,
  sleepFn = sleep,
  now = Date.now,
} = {}) {
  const pixels = width * height
  const output = new Uint8Array(pixels * 4)
  const mask = new Uint8Array(pixels)
  const startedAt = now()
  let ref = reference
  let stable = 0
  let checks = 0

  for (;;) {
    const tickStartedAt = now()
    if (tickStartedAt - startedAt >= maxWaitMs) {
      return { settled: false, quietMs: tickStartedAt - startedAt, checks, reference: ref }
    }
    if (onTick !== undefined) await onTick()
    const current = await capture()
    checks += 1

    output.fill(0)
    pixelmatch(ref, current, output, width, height, { threshold, diffMask: true })
    for (let i = 0; i < pixels; i++) mask[i] = output[i * 4 + 3] !== 0 ? 1 : 0

    if (changedPixels(mask, width, height, minArea) > 0) {
      ref = current
      stable = 0
    } else {
      stable += 1
      if (stable >= stableChecks) {
        return { settled: true, quietMs: now() - startedAt, checks, reference: ref }
      }
    }
    // 与主循环同一节奏算法：帧耗时超过间隔就直接接下一帧，不额外等。
    await sleepFn(Math.max(0, checkIntervalMs - (now() - tickStartedAt)))
  }
}

/**
 * 轮询等待屏幕相对 baseline 发生变化。
 * region 可选：只观察该局部区域（物理像素），区域外的任何变化（流式输出、闪烁）
 * 都被彻底忽略；返回的 regions bbox/offset 仍是全屏绝对坐标。
 * 检出变化后先过静默期（约 300ms 无新变化才算稳定，上限 2 秒），
 * 再落盘生成正式截图。返回 changed=true 时带 currentShotId/regions/coverage/quietMs/settled，
 * 超时未变时只带 changed=false + waitedMs + timeout=true，不产生任何新截图。
 */
export async function waitChangeAction({
  baseline,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  threshold = 0.1,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  minArea = DEFAULT_MIN_REGION_AREA,
  minCoverage = DEFAULT_MIN_COVERAGE,
  region,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`vp_wait_change: timeoutMs 必须是 >=0 的数字，收到 ${timeoutMs}`)
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`vp_wait_change: timeoutMs 最大 ${MAX_TIMEOUT_MS}ms，收到 ${timeoutMs}（要等更久请分多次调用）`)
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error(`vp_wait_change: pollIntervalMs 必须是 >=0 的数字，收到 ${pollIntervalMs}`)
  }

  const baselineMeta = get(baseline)
  if (baselineMeta === undefined) {
    throw new Error(
      `vp_wait_change: baseline shotId ${baseline} 不存在，可先用 vp_screenshot 截一张`,
    )
  }
  assertShotFileExists(baseline, baselineMeta, 'vp_wait_change')
  const baselineImg = readPng(baselineMeta.path)
  // region 校验先于会话创建：参数非法就不必去申请底层句柄。
  const regionBox = normalizeRegion(region, baselineMeta.width, baselineMeta.height, 'vp_wait_change: ')

  // 等待本身不要求授权；只有「带着持久授权开始等」的调用会被撤销打断。
  // 记在会话创建之前，这样建会话期间发生的撤销在第一次轮询时就能发现。
  const startedAllowed = checkCanClick().allowed
  const startedEpoch = getAuthEpoch()
  const assertWaitGrant = async () => {
    if (!startedAllowed) return
    // 让排队的撤销回调先落地，再同步复核；epoch 变化（含撤销后立刻重授权）一律中断。
    await Promise.resolve()
    if (!checkCanClick().allowed || getAuthEpoch() !== startedEpoch) {
      throw new Error('授权已被撤销，等待中断')
    }
  }

  const { Session } = loadRobotTs()
  const session = await Session.create()
  const startedAt = Date.now()
  let fired = false
  let waitedMs = 0
  let quietMs = 0
  let quietSettled = false
  let quietFrame = null

  try {
    if (!session.capabilities.canCaptureScreen) {
      throw new Error('当前宿主环境不支持屏幕捕获（canCaptureScreen=false）')
    }
    const primary = await session.screen.primaryMonitor()
    const { width, height } = primary.physicalBounds.size

    // 先验尺寸/缩放，别对一张坐标系已经不可信的 baseline 白等满超时。
    if (
      width !== baselineMeta.width ||
      height !== baselineMeta.height ||
      primary.scaleFactor !== baselineMeta.scaleFactor
    ) {
      throw new Error(
        `baseline 与当前主屏尺寸/缩放不一致（baseline: ${baselineMeta.width}x${baselineMeta.height}` +
        `@${baselineMeta.scaleFactor}，current: ${width}x${height}@${primary.scaleFactor}），` +
        '可能显示器或缩放变了，请重新截图',
      )
    }

    // region 模式下只比对该区域：baseline 裁一次，每帧把 captureMonitor 的整屏帧裁一块。
    const cmpBaseline = regionBox === undefined ? baselineImg : crop(baselineImg, regionBox)
    const cmpWidth = cmpBaseline.width
    const cmpHeight = cmpBaseline.height
    const cmpPixels = cmpWidth * cmpHeight
    const output = new Uint8Array(cmpPixels * 4)
    const mask = new Uint8Array(cmpPixels)

    for (;;) {
      await assertWaitGrant()
      const tickStartedAt = Date.now()
      const frame = await session.screen.captureMonitor(primary.id)
      const current = regionBox === undefined
        ? frame.toBuffer()
        : crop({ width, height, data: frame.toBuffer() }, regionBox).data

      // pixelmatch 在 diffMask 模式下只写「是差异」的那些像素，其余像素一个字节都不碰，
      // 所以复用缓冲必须先清零 —— 否则上一帧的差异会永久留在 mask 里。
      output.fill(0)
      pixelmatch(cmpBaseline.data, current, output, cmpWidth, cmpHeight, { threshold, diffMask: true })
      for (let i = 0; i < cmpPixels; i++) mask[i] = output[i * 4 + 3] !== 0 ? 1 : 0

      waitedMs = Date.now() - startedAt
      if (changedPixels(mask, cmpWidth, cmpHeight, minArea) / cmpPixels > minCoverage) {
        fired = true
        quietFrame = current
        break
      }
      // 已经开始的这一帧一定跑完，所以超时路径上的 waitedMs 必然 >= timeoutMs。
      if (waitedMs >= timeoutMs) break
      // 睡之前再查一次：把「撤销 → 醒来才发现」的延迟压到一帧以内。
      await assertWaitGrant()
      const interval = resolvePollInterval(waitedMs, pollIntervalMs)
      await sleep(Math.max(0, interval - (Date.now() - tickStartedAt)))
    }

    // 静默期：第一帧变化可能只是渲染中途（逐字输出、骨架屏），
    // 再观察一小段，连续 3 次没有新的实质变化才交还控制权。
    if (fired) {
      const quiet = await settleQuiet({
        reference: quietFrame,
        capture: async () => {
          const next = await session.screen.captureMonitor(primary.id)
          return regionBox === undefined
            ? next.toBuffer()
            : crop({ width, height, data: next.toBuffer() }, regionBox).data
        },
        width: cmpWidth,
        height: cmpHeight,
        threshold,
        minArea,
        onTick: assertWaitGrant,
      })
      quietMs = quiet.quietMs
      quietSettled = quiet.settled
      // waitedMs 对调用方而言是「从开始等到返回」的总时长，静默期也算在内。
      waitedMs = Date.now() - startedAt
    }
  } finally {
    await session.dispose()
  }

  if (!fired) {
    return { changed: false, waitedMs, timeout: true }
  }

  // 变化确认之后才落盘：这张才是模型可以回看、可以继续当 baseline 的正式截图。
  const current = await screenshotAction()
  const result = diffPair({
    baselineMeta,
    currentMeta: get(current.shotId),
    baselineShotId: baseline,
    currentShotId: current.shotId,
    threshold,
    minArea,
    region: regionBox,
  })

  return {
    changed: result.changed,
    waitedMs,
    timeout: false,
    quietMs,
    settled: quietSettled,
    currentShotId: result.currentShotId,
    regions: result.regions,
    coverage: result.coverage,
    baselineShotId: result.baselineShotId,
    coordinateContract: result.coordinateContract,
  }
}
