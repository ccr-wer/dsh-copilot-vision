// 落盘目录的唯一真相：截图与授权审计日志同目录。
// 默认 os.tmpdir()/vision-pilot-shots，VP_SHOT_DIR 覆盖（绝对路径优先）。
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readdir, stat, unlink } from 'node:fs/promises'

export function resolveShotsDir() {
  const override = process.env.VP_SHOT_DIR
  if (override !== undefined && override.trim() !== '') return resolve(override.trim())
  return join(tmpdir(), 'vision-pilot-shots')
}

// 差分/网格切片的可再生垃圾：3 天后允许清理。
// 全屏基准图（vp-shot-*）与审计日志（audit.log）是证据链，永久保留——
// 本函数的文件名过滤在结构上保证永远碰不到它们。
export const FRAGMENT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/** 启动时异步清理一次。任何失败（目录不存在、文件被占用、权限不足）都静默跳过，绝不阻断启动。 */
export async function cleanupVisualFragments(maxAgeMs = FRAGMENT_MAX_AGE_MS) {
  let names
  try {
    names = await readdir(resolveShotsDir())
  } catch {
    return { removed: 0, failed: 0 }
  }
  let removed = 0
  let failed = 0
  for (const name of names) {
    if (!/^vp-(diff|grid)-\d+-\d+\.png$/.test(name)) continue
    try {
      const dir = resolveShotsDir()
      const info = await stat(join(dir, name))
      if (!info.isFile() || Date.now() - info.mtimeMs <= maxAgeMs) continue
      await unlink(join(dir, name))
      removed++
    } catch {
      failed++
    }
  }
  return { removed, failed }
}
