// 位置编码渲染：把差分区域裁出来、按面积自适应倍率最近邻放大、叠加半透明红色网格，
// 让模型在「带标尺的放大镜」上数格子，而不是在全屏小图上目测偏移。
//
// 选型（不引新依赖）：只用 pngjs + 手写 Bresenham。
//   - @napi-rs/canvas / node-canvas：原生绑定，装包与跨机器重建都有成本，而这里只需要直线。
//   - pureimage：纯 JS 但会引入字体与路径体系，同样超出需求。
//   - 直接在 RGBA buffer 上写像素：零新增依赖、结果完全可预测（无抗锯齿、无二次插值）。
// 网格线是唯一会「污染」像素的地方：半透明混合后 R 保持高位、G/B 减半，
// 所以放大图仍能看清底下的文字，网格也可被像素级测试客观识别。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { resolveShotsDir } from './paths.js'

export const GRID_SCALE = 4
export const GRID_STEP_PHYSICAL = 20
// 4x 档的图内步距（放大图上每格像素数）；其余档位 = GRID_STEP_PHYSICAL × 倍数。
export const GRID_STEP_IMAGE = GRID_SCALE * GRID_STEP_PHYSICAL // 80

// 自适应倍率阈值（物理像素面积）：小区域 4x 保极限精度，中区域 2x 体积减半，
// 大区域（整页刷新级）1x 只画网格 —— 1920x1200 全屏若 4x = 7680x4800 ≈ 147MB RGBA，绝不可接受。
// 1x 后输出不可能超过源截图本身，所以不再需要旧的 250k 物理像素 gridSkipped 上限。
export const GRID_AREA_MAX_4X = 50_000
export const GRID_AREA_MAX_2X = 200_000

/** 按区域物理像素面积选放大倍数：<=50000 → 4，<=200000 → 2，否则 1。 */
export function resolveGridScale(area) {
  if (area <= GRID_AREA_MAX_4X) return 4
  if (area <= GRID_AREA_MAX_2X) return 2
  return 1
}

const LINE_R = 255
const LINE_G = 0
const LINE_B = 0
export const GRID_ALPHA = 0.5

function blendPixel(png, x, y, alpha) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return
  const i = (y * png.width + x) * 4
  png.data[i] = Math.round(png.data[i] * (1 - alpha) + LINE_R * alpha)
  png.data[i + 1] = Math.round(png.data[i + 1] * (1 - alpha) + LINE_G * alpha)
  png.data[i + 2] = Math.round(png.data[i + 2] * (1 - alpha) + LINE_B * alpha)
  png.data[i + 3] = 255
}

/** 整数 Bresenham 画线。当前只画水平/垂直，保留通用形式以免以后再加一份对角线版本。 */
function drawLine(png, x0, y0, x1, y1, alpha = GRID_ALPHA) {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    blendPixel(png, x, y, alpha)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

/**
 * 从源截图裁剪 bbox、按 resolveGridScale(面积) 自适应倍率最近邻放大、
 * 每 GRID_STEP_PHYSICAL 物理像素画一条半透明红线，
 * 落盘为 vp-grid-<shotId>-<index>.png。网格原点 = bbox 左上角（bbox 内第 0 个物理像素）。
 *
 * 文件名里的 shotId/index 不在规格签名里，但文件名要求它们，所以通过第 4 个参数传入；
 * scaleFactor 只参与校验与元数据，不参与像素计算（bbox 本身就是物理像素）。
 */
export function generateGridImage(sourcePngPath, bbox, scaleFactor, { shotId, index } = {}) {
  if (
    bbox === null || typeof bbox !== 'object' ||
    !Number.isInteger(bbox.x) || !Number.isInteger(bbox.y) ||
    !Number.isInteger(bbox.width) || !Number.isInteger(bbox.height)
  ) {
    throw new Error(`generateGridImage: bbox 必须是 4 个整数，收到 ${JSON.stringify(bbox)}`)
  }
  if (bbox.width < 1 || bbox.height < 1) {
    throw new Error(`generateGridImage: bbox 宽高必须 >=1，收到 ${bbox.width}x${bbox.height}`)
  }
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(`generateGridImage: scaleFactor 必须是正数，收到 ${scaleFactor}`)
  }
  if (!Number.isInteger(shotId) || !Number.isInteger(index) || index < 1) {
    throw new Error(
      `generateGridImage: 需要正整数 shotId 与 1-based index 才能命名 vp-grid-<shotId>-<index>.png，` +
      `收到 shotId=${shotId}, index=${index}`,
    )
  }
  const scale = resolveGridScale(bbox.width * bbox.height)

  const source = PNG.sync.read(readFileSync(sourcePngPath))
  if (bbox.x + bbox.width > source.width || bbox.y + bbox.height > source.height) {
    throw new Error(
      `generateGridImage: bbox (${bbox.x}, ${bbox.y}) ${bbox.width}x${bbox.height} ` +
      `超出源图 ${source.width}x${source.height}`,
    )
  }

  const outWidth = bbox.width * scale
  const outHeight = bbox.height * scale
  const out = new PNG({ width: outWidth, height: outHeight })
  const rowBuf = Buffer.alloc(outWidth * 4)

  for (let sy = 0; sy < bbox.height; sy++) {
    const srcRow = ((bbox.y + sy) * source.width + bbox.x) * 4
    for (let dx4 = 0; dx4 < outWidth * 4; dx4 += 4) {
      // dx4/4 = 目标列，再除以 scale 才是源列（最近邻：目标 scale 列共用 1 源像素）。
      const from = srcRow + ((dx4 / (4 * scale)) | 0) * 4
      rowBuf[dx4] = source.data[from]
      rowBuf[dx4 + 1] = source.data[from + 1]
      rowBuf[dx4 + 2] = source.data[from + 2]
      rowBuf[dx4 + 3] = source.data[from + 3]
    }
    for (let k = 0; k < scale; k++) {
      rowBuf.copy(out.data, (sy * scale + k) * outWidth * 4)
    }
  }

  for (let x = 0; x < outWidth; x += GRID_STEP_PHYSICAL * scale) drawLine(out, x, 0, x, outHeight - 1)
  for (let y = 0; y < outHeight; y += GRID_STEP_PHYSICAL * scale) drawLine(out, 0, y, outWidth - 1, y)

  const dir = resolveShotsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `vp-grid-${shotId}-${index}.png`)
  writeFileSync(path, PNG.sync.write(out))
  return path
}
