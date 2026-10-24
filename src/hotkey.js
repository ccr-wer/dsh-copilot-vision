// 全局热键：Shift+Space → togglePersistent()。
// robot-ts 没有 hotkey API，但 EventTap 能全局捕获键盘事件（非管理员可用）。
// 生命周期由 index.js 的 ctx.effect 负责 dispose —— 这是长驻资源，不随单次工具调用结束。
//
// Fail-Closed：热键是 persistent 唯一的人类急停通道。监听器一旦失效（线程退出、系统卸载、
// 会话被回收），必须立刻通知宿主把授权强制收回 unauthorized，而不是留着一个按不动的持续授权。
// 心跳只能看见绑定暴露的状态（isEventTapRunning）；Windows 静默摘钩但消息循环仍在跑的
// 情况在该 API 下不可观测，见 README「已知限制」。

import { loadRobotTs } from './robot-ts.js'

export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 2000

export async function startHotkey({
  onToggle,
  onUnavailable,
  healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  // 依赖注入点：生产用真实 robot-ts，回归测试用假 Session 驱动心跳。
  load = loadRobotTs,
} = {}) {
  let session
  let disposed = false
  let failed = false
  let timer

  const stopHealthCheck = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const shutdown = async () => {
    stopHealthCheck()
    try { await session?.eventTap.stop() } catch { /* already stopped */ }
    try { await session?.dispose() } catch { /* already disposed */ }
  }

  // 只通知一次：心跳与 dispose 可能同时到达，重复 revokeAll 会污染审计。
  const markUnavailable = (reason) => {
    if (failed || disposed) return
    failed = true
    stopHealthCheck()
    try {
      onUnavailable?.(reason)
    } catch {
      // 回调是 fail-closed 的通知通道，它自己出错也不能让钩子线程崩。
    }
    void shutdown()
  }

  try {
    const { Session, Key } = load()
    session = await Session.create()

    if (!session.eventTap.isSupported) {
      await shutdown()
      return { available: false, error: '当前环境不支持 EventTap 全局键盘捕获', dispose: async () => {} }
    }

    let shiftHeld = false
    let spaceHeld = false

    // KeyInputEvent 只有 { type, key, down }，native 绑定的属性名里也没有任何注入标记，
    // 所以这里无法过滤合成按键 —— 见 README「安全边界」。
    await session.eventTap.start((event) => {
      try {
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
          onToggle()
        }
      } catch {
        // 热键回调运行在原生钩子路径上，异常绝不能外抛。
      }
    })

    // 心跳：定时问绑定「钩子线程还活着吗」。start 成功后再装，避免把启动期误判成失效。
    // healthCheckIntervalMs <= 0 表示关闭（保留给需要零后台定时的宿主）。
    if (healthCheckIntervalMs > 0) {
      timer = setInterval(() => {
        let running
        try {
          running = session.eventTap.isRunning
        } catch (error) {
          markUnavailable(
            `EventTap 心跳检查失败：${error instanceof Error ? error.message : String(error)}，已强制撤销全部授权`,
          )
          return
        }
        if (!running) {
          markUnavailable('EventTap 已停止：全局钩子失效，已强制撤销全部授权')
        }
      }, healthCheckIntervalMs)
      timer.unref?.()
    }

    return {
      available: true,
      error: undefined,
      healthCheckIntervalMs,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await shutdown()
      },
    }
  } catch (error) {
    await shutdown()
    const message = error instanceof Error ? error.message : String(error)
    markUnavailable(`EventTap 启动失败：${message}，已强制撤销全部授权`)
    return {
      available: false,
      error: message,
      dispose: async () => {},
    }
  }
}
