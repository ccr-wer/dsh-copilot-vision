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
// 边界：仍然只有主屏全屏；不做区域等待、不做多显示器、不缓存历史帧。
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { loadRobotTs } from './robot-ts.js'
import { get, assertShotFileExists } from './shot-index.js'
import { checkCanClick, getAuthEpoch } from './auth.js'
import { screenshotAction } from './actions.js'
import { diffPair, connectedComponents, DEFAULT_MIN_REGION_AREA } from './diff.js'

export const DEFAULT_POLL_INTERVAL_MS = 100
export const DEFAULT_TIMEOUT_MS = 3000
// 工具参数由模型给，不设上限就等于让它自己挑一个能挂住宿主的等待时长。
export const MAX_TIMEOUT_MS = 30000
// 过滤噪声后的差异像素占整屏比例超过它才算「变了」。光标/插入符闪烁约 400 像素
// ≈ 1.7e-4，取一个数量级余量。
export const DEFAULT_MIN_COVERAGE = 0.001

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * 轮询等待屏幕相对 baseline 发生变化。
 * 返回 changed=true 时带 currentShotId/regions/coverage（来自落盘后的正式截图），
 * 超时未变时只带 changed=false + waitedMs + timeout=true，不产生任何新截图。
 */
export async function waitChangeAction({
  baseline,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  threshold = 0.1,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  minArea = DEFAULT_MIN_REGION_AREA,
  minCoverage = DEFAULT_MIN_COVERAGE,
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

    const pixels = width * height
    const output = new Uint8Array(pixels * 4)
    const mask = new Uint8Array(pixels)

    for (;;) {
      await assertWaitGrant()
      const tickStartedAt = Date.now()
      const frame = await session.screen.captureMonitor(primary.id)
      const current = frame.toBuffer()

      // pixelmatch 在 diffMask 模式下只写「是差异」的那些像素，其余像素一个字节都不碰，
      // 所以复用缓冲必须先清零 —— 否则上一帧的差异会永久留在 mask 里。
      output.fill(0)
      pixelmatch(baselineImg.data, current, output, width, height, { threshold, diffMask: true })
      for (let i = 0; i < pixels; i++) mask[i] = output[i * 4 + 3] !== 0 ? 1 : 0

      waitedMs = Date.now() - startedAt
      if (changedPixels(mask, width, height, minArea) / pixels > minCoverage) {
        fired = true
        break
      }
      // 已经开始的这一帧一定跑完，所以超时路径上的 waitedMs 必然 >= timeoutMs。
      if (waitedMs >= timeoutMs) break
      // 睡之前再查一次：把「撤销 → 醒来才发现」的延迟压到一帧以内。
      await assertWaitGrant()
      await sleep(Math.max(0, pollIntervalMs - (Date.now() - tickStartedAt)))
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
  })

  return {
    changed: result.changed,
    waitedMs,
    timeout: false,
    currentShotId: result.currentShotId,
    regions: result.regions,
    coverage: result.coverage,
    baselineShotId: result.baselineShotId,
    coordinateContract: result.coordinateContract,
  }
}
