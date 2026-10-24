// 语义级记忆压缩：把关键截图归档，其余临时碎片一次清空。
//
// 与 paths.js 的 cleanupVisualFragments 的分工（两者不冲突）：
//   - cleanupVisualFragments 是「按时间的兜底」：只在插件启动时删 3 天前的 diff/grid，
//     永远不碰 vp-shot-*，永远不递归子目录。
//   - 本函数是「按语义的主清理」：由模型在收工时显式调用，删所有 diff/grid 和没被保留的 vp-shot-*。
//   主清理的目标集合是兜底清理的超集，先跑谁都不会破坏另一方。
//
// 绝对不动的三样：audit.log（证据链）、shot-index.json（shotId 播种与相对点击依赖它）、archives/（归档本体）。
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolveShotsDir } from './paths.js'
import { get, relocate } from './shot-index.js'

export const ARCHIVE_DIR_NAME = 'archives'
export const SUMMARY_FILE_NAME = 'archive-summary.txt'

export function archiveDir() {
  return join(resolveShotsDir(), ARCHIVE_DIR_NAME)
}

export function summaryPath() {
  return join(resolveShotsDir(), SUMMARY_FILE_NAME)
}

const DIFF_RE = /^vp-diff-\d+-\d+\.png$/
const GRID_RE = /^vp-grid-\d+-\d+\.png$/
const SHOT_RE = /^vp-shot-.*\.png$/

/**
 * 收工清理。
 * @param {{keepShotIds: number[], summary: string}} args
 * @returns 归档/缺失清单与各类删除计数（供工具层回显）。
 */
export async function summarizeAction({ keepShotIds = [], summary } = {}) {
  if (!Array.isArray(keepShotIds) || keepShotIds.some((id) => !Number.isInteger(id))) {
    throw new Error(`vp_summarize: keepShotIds 必须是整数数组，收到 ${JSON.stringify(keepShotIds)}`)
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new Error('vp_summarize: summary 必须是非空字符串')
  }

  const dir = resolveShotsDir()
  const archives = archiveDir()
  await mkdir(archives, { recursive: true })

  const archivedShotIds = []
  const missingShotIds = []
  const failedShotIds = []
  const keepNames = new Set()

  // 先归档再删除：顺序反了会把要保留的图当成「没被选中」删掉。
  for (const shotId of new Set(keepShotIds)) {
    const meta = get(shotId)
    if (meta === undefined) {
      missingShotIds.push(shotId)
      continue
    }
    const name = basename(meta.path)
    const sourcePath = join(dir, name)
    const archivedPath = join(archives, name)

    try {
      if (existsSync(sourcePath)) {
        await rename(sourcePath, archivedPath)
      }
    } catch {
      // 归档失败（文件被别的程序占用等）时绝不能继续往下走：
      // 删循环会把仍在原位的源文件当成「没被保留」删掉。先把它记进 keepNames 保命。
      keepNames.add(name)
      failedShotIds.push(shotId)
      continue
    }
    // 源和归档都不在，说明这张图已经丢过一次了，如实报缺失。
    if (!existsSync(archivedPath)) {
      missingShotIds.push(shotId)
      continue
    }

    relocate(shotId, archivedPath)
    keepNames.add(name)
    archivedShotIds.push(shotId)
  }

  const block = [
    `[${new Date().toISOString()}] keep=${archivedShotIds.join(',') || '(none)'}`,
    summary.trim(),
    '',
  ].join('\n')
  await appendFile(summaryPath(), block, 'utf8')

  let removedShots = 0
  let removedDiff = 0
  let removedGrid = 0
  let failedDeletes = 0

  // 只扫顶层：archives/ 是目录，正则匹配不到；即便将来名字撞上，isFile 检查也会挡住。
  for (const name of await readdir(dir)) {
    const isDiff = DIFF_RE.test(name)
    const isGrid = GRID_RE.test(name)
    const isShot = SHOT_RE.test(name)
    if (!isDiff && !isGrid && !isShot) continue
    if (isShot && keepNames.has(name)) continue
    try {
      const info = await stat(join(dir, name))
      if (!info.isFile()) continue
      await unlink(join(dir, name))
      if (isDiff) removedDiff++
      else if (isGrid) removedGrid++
      else removedShots++
    } catch {
      failedDeletes++
    }
  }

  return {
    summary: summary.trim(),
    archivedShotIds,
    missingShotIds,
    failedShotIds,
    failedArchives: failedShotIds.length,
    removedShots,
    removedDiff,
    removedGrid,
    removedTotal: removedShots + removedDiff + removedGrid,
    failedDeletes,
    archivesDir: archives,
    summaryPath: summaryPath(),
  }
}
