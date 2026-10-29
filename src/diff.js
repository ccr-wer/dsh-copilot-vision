// 截图差分：把「当前屏幕」与索引里某张历史截图逐像素比对，
// 输出若干连通差异区域及其局部裁剪图，供模型只看变化部分而不是整屏。
//
// 边界（有意为之，不是欠债）：
//   - localPath 仍是原尺寸裁剪：局部坐标 + bbox 左上角 = 全局物理坐标，模型可以直接换算。
//   - 额外产出的 gridPath 是按面积与单边长度自适应倍率的「网格放大镜」（小区域 4x / 中区域 2x / 大区域 1x，
//     放大后单边不超过 2000 像素，见 render.js），
//     它只用于目测/相对点击，不改变 localPath 的 1:1 语义；倍数随区域以 gridScale 字段返回。
//   - 可选 region：只比对 (x,y) 起点的 width×height 局部（物理像素），区域外任何变化彻底忽略；
//     返回的 bbox/offset 仍加回 region 偏移、是全屏绝对坐标，coverage 的分母是被比对区域面积。
//   - 不做高频抽帧，只在调用时截一张当前图。
//   - 尺寸/缩放不一致时直接抛错，不做任何重采样或硬算 —— 显示器或缩放变了，
//     旧截图的坐标系已经不可信，勉强对齐只会给出错误坐标。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { screenshotAction } from './actions.js'
import { get, recordRegions, assertShotFileExists } from './shot-index.js'
import { resolveShotsDir } from './paths.js'
import { generateGridImage, resolveGridScale } from './render.js'

// 小于这个像素数的连通区域按噪声丢弃（光标闪烁、 blinking caret、亚像素抖动）。
export const DEFAULT_MIN_REGION_AREA = 100

// 网格图的成本是「每个区域一次放大 + PNG 编码」，差异块很多时（实测出现过单次 105 块）
// 全量生成只会拖慢工具并堆满临时目录，所以只给前 N 个（按面积降序）配网格图。
export const MAX_GRID_REGIONS = 12

function readPng(path) {
  return PNG.sync.read(readFileSync(path))
}

/** 找出 mask 里的 4 邻域连通块，返回像素数与包围盒（图像坐标系，左上角原点）。 */
export function connectedComponents(mask, width, height) {
  const total = width * height
  const visited = new Uint8Array(total)
  const components = []

  for (let seed = 0; seed < total; seed++) {
    if (mask[seed] === 0 || visited[seed] === 1) continue
    visited[seed] = 1
    const queue = [seed]
    let pixels = 0
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1

    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]
      pixels += 1
      const x = cur % width
      const y = (cur / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      const push = (n) => {
        if (mask[n] === 1 && visited[n] === 0) {
          visited[n] = 1
          queue.push(n)
        }
      }
      if (x > 0) push(cur - 1)
      if (x < width - 1) push(cur + 1)
      if (y > 0) push(cur - width)
      if (y < height - 1) push(cur + width)
    }

    components.push({
      pixels,
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    })
  }
  return components
}

/** 从源图裁出 bbox 大小的 PNG（原尺寸，不缩放）。bbox 必须完全落在源图内。 */
export function crop(source, bbox) {
  const out = new PNG({ width: bbox.width, height: bbox.height })
  for (let row = 0; row < bbox.height; row++) {
    const from = ((bbox.y + row) * source.width + bbox.x) * 4
    source.data.copy(
      out.data,
      row * bbox.width * 4,
      from,
      from + bbox.width * 4,
    )
  }
  return out
}

/**
 * 校验并归一化可选 region 参数（物理像素整数），返回 {x, y, width, height}；
 * 未传返回 undefined。坐标契约上像素必须是整数——region 被裁剪与偏移换算共用，
 * 非整数会同时污染 bbox 与覆盖率分母。
 */
export function normalizeRegion(region, screenWidth, screenHeight, tool = '') {
  if (region === undefined) return undefined
  if (region === null || typeof region !== 'object' || Array.isArray(region)) {
    throw new Error(
      `${tool}region 必须是 {x, y, width, height} 对象（物理像素），收到 ${JSON.stringify(region)}`,
    )
  }
  const { x, y, width, height } = region
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isInteger(region[key])) {
      throw new Error(`${tool}region.${key} 必须是整数物理像素，收到 ${region[key]}`)
    }
  }
  if (x < 0 || y < 0) {
    throw new Error(`${tool}region 的 x/y 不能为负，收到 (${x}, ${y})`)
  }
  if (width < 1 || height < 1) {
    throw new Error(`${tool}region 的 width/height 必须 >=1，收到 ${width}x${height}`)
  }
  if (x + width > screenWidth || y + height > screenHeight) {
    throw new Error(
      `${tool}region 越界：屏幕 ${screenWidth}x${screenHeight}，` +
      `region (${x},${y}) ${width}x${height} 超出范围`,
    )
  }
  return { x, y, width, height }
}

const formatDims = (meta) => `${meta.width}x${meta.height}@${meta.scaleFactor}`

/**
 * 对两张已落盘的截图做差分。不碰屏幕，可被单元测试直接调用。
 * 两个 meta 都来自 shot-index（path/width/height/scaleFactor）。
 * region 可选：只比对该局部区域（物理像素），区域外变化彻底忽略；
 * 返回的 bbox/offset 已加回 region 偏移（全屏绝对坐标），
 * coverage 分母为被比对区域面积（默认整屏，region 模式为 region 面积）。
 */
export function diffPair({
  baselineMeta,
  currentMeta,
  baselineShotId,
  currentShotId,
  threshold = 0.1,
  minArea = DEFAULT_MIN_REGION_AREA,
  region,
} = {}) {
  if (
    baselineMeta.width !== currentMeta.width ||
    baselineMeta.height !== currentMeta.height ||
    baselineMeta.scaleFactor !== currentMeta.scaleFactor
  ) {
    throw new Error(
      `baseline 与当前截图尺寸/缩放不一致（baseline: ${formatDims(baselineMeta)}，` +
      `current: ${formatDims(currentMeta)}），可能显示器或缩放变了，请重新截图`,
    )
  }

  const baselineFull = readPng(baselineMeta.path)
  const currentFull = readPng(currentMeta.path)
  const box = normalizeRegion(region, baselineFull.width, baselineFull.height)

  const baseline = box === undefined ? baselineFull : crop(baselineFull, box)
  const current = box === undefined ? currentFull : crop(currentFull, box)
  const width = baseline.width
  const height = baseline.height

  // diffMask=true：输出缓冲里只有真正的差异像素非零（被判定为抗锯齿的像素不进 mask），
  // alpha 通道即差异掩码。
  const output = new Uint8Array(width * height * 4)
  pixelmatch(baseline.data, current.data, output, width, height, { threshold, diffMask: true })

  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = output[i * 4 + 3] !== 0 ? 1 : 0
  }

  const kept = connectedComponents(mask, width, height)
    .filter((component) => component.pixels >= minArea)
    .sort((a, b) => b.pixels - a.pixels)
    // 连通块是在被比对的（可能已裁剪的）图上算的；bbox 必须加回 region 偏移，
    // 让下游拿到的永远是全屏绝对物理坐标（vp_click_relative 依赖这一点）。
    .map((component) => ({
      pixels: component.pixels,
      bbox: {
        x: component.bbox.x + (box?.x ?? 0),
        y: component.bbox.y + (box?.y ?? 0),
        width: component.bbox.width,
        height: component.bbox.height,
      },
    }))

  const dir = resolveShotsDir()
  mkdirSync(dir, { recursive: true })

  const regions = kept.map((component, i) => {
    const bbox = component.bbox
    const localPath = join(dir, `vp-diff-${currentShotId}-${i + 1}.png`)
    writeFileSync(localPath, PNG.sync.write(crop(currentFull, bbox)))
    const region = {
      // offset 就是 bbox 左上角：局部图未放大，(0,0) 对应全局 offset。
      bbox,
      localPath,
      offset: { x: bbox.x, y: bbox.y },
    }
    if (i >= MAX_GRID_REGIONS) {
      region.gridSkipped = `只给前 ${MAX_GRID_REGIONS} 个区域生成网格图（本区域排第 ${i + 1}）`
    } else {
      region.gridScale = resolveGridScale(bbox.width, bbox.height)
      region.gridPath = generateGridImage(currentMeta.path, bbox, currentMeta.scaleFactor, {
        shotId: currentShotId,
        index: i + 1,
      })
    }
    return region
  })

  // 索引里没有 currentShotId 时（直接调 diffPair 的测试场景）跳过，不影响差分结果本身。
  recordRegions(currentShotId, regions)

  const changedPixels = kept.reduce((sum, component) => sum + component.pixels, 0)

  return {
    changed: regions.length > 0,
    regions,
    // 分母是被比对的面积：默认整屏，region 模式下是 region 面积。
    coverage: regions.length === 0 ? 0 : changedPixels / (width * height),
    baselineShotId,
    currentShotId,
    coordinateContract: 'physical',
  }
}

/** 截一张当前图，与 baselineShotId 指向的历史截图做差分。region 可选：只比对局部区域。 */
export async function diffAction({
  baseline,
  threshold = 0.1,
  minArea = DEFAULT_MIN_REGION_AREA,
  region,
} = {}) {
  const baselineMeta = get(baseline)
  if (baselineMeta === undefined) {
    throw new Error(
      `vp_screenshot_diff: baseline shotId ${baseline} 不存在，可先用 vp_screenshot 截一张`,
    )
  }
  assertShotFileExists(baseline, baselineMeta, 'vp_screenshot_diff')
  // region 合法性先验：不合法就不必白截一张图（还白占一个 shotId）。
  normalizeRegion(region, baselineMeta.width, baselineMeta.height, 'vp_screenshot_diff: ')
  const current = await screenshotAction()
  return diffPair({
    baselineMeta,
    currentMeta: get(current.shotId),
    baselineShotId: baseline,
    currentShotId: current.shotId,
    threshold,
    minArea,
    region,
  })
}
