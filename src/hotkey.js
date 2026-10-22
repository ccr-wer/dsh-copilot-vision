// 全局热键：Shift+Space → togglePersistent()。
// robot-ts 没有 hotkey API，但 EventTap 能全局捕获键盘事件（非管理员可用）。
// 生命周期由 index.js 的 ctx.effect 负责 dispose —— 这是长驻资源，不随单次工具调用结束。

import { loadRobotTs } from './robot-ts.js'

export async function startHotkey({ onToggle }) {
  let session
  try {
    const { Session, Key } = loadRobotTs()
    session = await Session.create()

    if (!session.eventTap.isSupported) {
      await session.dispose()
      return { available: false, error: '当前环境不支持 EventTap 全局键盘捕获', dispose: async () => {} }
    }

    let shiftHeld = false
    let spaceHeld = false

    // KeyInputEvent 只有 { type, key, down }，native 绑定的属性名里也没有任何注入标记，
    // 所以这里无法过滤合成按键 —— 见 README「安全边界」。

    await session.eventTap.start((event) => {
      if (event.type !== 'key') return
      if (event.key === Key.LeftShift || event.key === Key.RightShift) {
        shiftHeld = event.down
        return
      }
      if (event.key !== Key.Space) return
      const wasDown = spaceHeld
      spaceHeld = event.down
      // 只在 Space 的按下沿触发，避免按住时的键盘重复把授权反复开关。
      if (event.down && !wasDown && shiftHeld) {
        try {
          onToggle()
        } catch {
          // 热键回调运行在原生钩子路径上，异常绝不能外抛。
        }
      }
    })

    return {
      available: true,
      error: undefined,
      dispose: async () => {
        try { await session.eventTap.stop() } catch { /* already stopped */ }
        try { await session.dispose() } catch { /* already disposed */ }
      },
    }
  } catch (error) {
    if (session !== undefined) {
      try { await session.dispose() } catch { /* already disposed */ }
    }
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      dispose: async () => {},
    }
  }
}
