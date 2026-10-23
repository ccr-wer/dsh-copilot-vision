// 截图索引：shotId → 该次截图的落盘路径与几何元数据。
// 差分和后续任何「回看某一张历史截图」的能力都只依赖这张表，所以把它单独拆出来，
// 而不是散落在 actions.js 里。
//
// 落盘策略是有意的：JSON 不是行式格式，无法像审计日志那样 append，
// 所以每次 record 都用 writeFileSync 全量覆盖。MVP 假定单进程、工具调用串行，
// 因此不做并发保护（两个进程同时写会互相覆盖，属于已知取舍，不是隐藏 bug）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveShotsDir } from './paths.js'

let index = null
let nextId = null
let notice = null

/** 索引文件路径，与截图、审计日志同目录（受 VP_SHOT_DIR 覆盖）。 */
export function shotIndexPath() {
  return join(resolveShotsDir(), 'shot-index.json')
}

function flush() {
  mkdirSync(resolveShotsDir(), { recursive: true })
  writeFileSync(shotIndexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

function quarantine(reason) {
  const p = shotIndexPath()
  const kept = `${p}.corrupt-${Date.now()}`
  try {
    renameSync(p, kept)
    notice = `截图索引已损坏（${reason}），原文件保留为 ${kept}，现在从空索引开始。历史 shotId 全部失效。`
  } catch (error) {
    notice = `截图索引已损坏（${reason}），但重命名失败（${error.message}），现在从空索引开始。历史 shotId 全部失效。`
  }
  index = {}
}

function load() {
  if (index !== null) return index
  let raw
  try {
    raw = readFileSync(shotIndexPath(), 'utf8')
  } catch (error) {
    // 首次运行没有索引文件，属正常状态，不必告知。
    if (error?.code === 'ENOENT') {
      index = {}
      return index
    }
    quarantine(error.message)
    return index
  }
  if (raw.trim() === '') {
    index = {}
    return index
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`内容不是对象，实际是 ${Array.isArray(parsed) ? 'array' : String(parsed)}`)
    }
    index = parsed
  } catch (error) {
    quarantine(error.message)
  }
  return index
}

/**
 * 分配 shotId：首次调用按盘上已有键的最大值播种（空索引或损坏隔离后为 1），之后进程内自增。
 * 播种是必要的：否则宿主重启后新截图会复用 1、2、3…，把旧条目的键顶掉，
 * 于是模型手里的 baseline shotId 会静默指向另一张图 —— 差分结果看着合理但坐标是错的。
 * 运行中外部改动索引文件不在 MVP 考虑范围内（不做热重载）。
 */
export function nextShotId() {
  if (nextId === null) nextId = seedNextId()
  const id = nextId
  nextId += 1
  return id
}

function seedNextId() {
  let max = 0
  for (const key of Object.keys(load())) {
    const n = Number(key)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}

/** 写入一条元数据并全量落盘；createdAt 由索引生成，调用方不传。 */
export function record(shotId, meta) {
  load()
  index[String(shotId)] = {
    path: meta.path,
    width: meta.width,
    height: meta.height,
    scaleFactor: meta.scaleFactor,
    physicalBounds: meta.physicalBounds,
    createdAt: new Date().toISOString(),
  }
  flush()
  return index[String(shotId)]
}

export function get(shotId) {
  if (!Number.isFinite(shotId)) return undefined
  return load()[String(shotId)]
}

/**
 * 把差分区域挂到某张截图的索引条目上。
 * vp_click_relative 用 shotId + 1-based index 反查 bbox，所以区域必须随索引落盘 ——
 * 只放在工具返回值里的话，宿主重启后模型手里的 currentShotId 就再也点不了了。
 */
export function recordRegions(shotId, regions) {
  const entry = get(shotId)
  if (entry === undefined) return false
  entry.regions = regions.map((region) => ({
    bbox: { ...region.bbox },
    localPath: region.localPath,
    ...(region.gridPath !== undefined ? { gridPath: region.gridPath, gridScale: region.gridScale } : {}),
  }))
  flush()
  return true
}

/** 全量快照的浅拷贝，供调试/测试读取，不代表落盘顺序。 */
export function all() {
  return { ...load() }
}

/**
 * 取走并清空「索引损坏」告知。
 * 由工具的 render 调用，所以每个进程只说一次 —— 损坏后静默继续会让模型
 * 拿着一个指向别的截图的 shotId 做决策，这是不能被吞掉的错误。
 */
export function consumeNotice() {
  if (notice === null) return undefined
  const value = notice
  notice = null
  return value
}

/** 测试用：丢弃内存副本与已播种的计数器，下一次读取重新走盘（会再次触发损坏分支与播种）。 */
export function _reloadForTests() {
  index = null
  notice = null
  nextId = null
}
