// 授权审计日志：JSON Lines 追加写到 audit.log（与截图同目录，VP_SHOT_DIR 可覆盖）。
// 只记录状态机动作、动作来源与前后状态；不记录任何按键内容，也不记录坐标以外的用户输入。
//
// 同步写盘是有意的：状态机的迁移函数都是同步的，异步排队会打乱事件顺序，
// 而审计日志的价值恰恰在于顺序可信。单行几百字节，耗时可忽略。
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveShotsDir } from './paths.js'

// 状态机会记录的动作集合（回归测试据此校验，不要在这里放实现分支）。
// actionAllowed / actionDenied 不改变授权状态，只记录某次注入被放行或被闸门拦截。
export const AUDIT_ACTIONS = [
  'requestAuth',
  'confirmPending',
  'cancelPending',
  'togglePersistent',
  'actionAllowed',
  'actionDenied',
]

export function auditLogPath() {
  return join(resolveShotsDir(), 'audit.log')
}

/** 追加一条动作记录。字段固定为 timestamp/action/source/previousState/newState/extra?。 */
export function logState(action, source, previousState, newState, extra) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    source,
    previousState,
    newState,
    ...(extra !== undefined ? { extra } : {}),
  }
  try {
    mkdirSync(resolveShotsDir(), { recursive: true })
    appendFileSync(auditLogPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* 尽力而为：审计缺失是事后追溯能力的损失，不是放权的理由。 */
  }
}
