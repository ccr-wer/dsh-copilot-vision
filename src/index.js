// Vision-Pilot 插件入口（Cordis 适配层）。
//
// 三层结构：
//   actions.js  —— 业务逻辑（robot-ts + 授权闸门，可被回归测试直接调用）
//   plugin.js   —— 工具定义（createPlugin(defineTool, ctx, hotkeyState)）
//   index.js    —— 本文件：注入宿主 defineTool/ctx，并把热键生命周期交给 ctx.effect
//
// @deepseek-ai/dsh-tools 与 @deepseek-ai/cordis 由宿主以 peerDependency 提供
// （声明见 package.json），本地 node_modules 中不存在属正常现象。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPlugin } from './plugin.js'
import { startHotkey } from './hotkey.js'
import { togglePersistent, revokeAll } from './auth.js'
import { cleanupVisualFragments } from './paths.js'

export const name = 'dsh-copilot-vision'
export const inject = ['tools', 'userQuestions']

export function apply(ctx) {
  const hotkeyState = { available: false, error: '热键尚未初始化' }

  // 热键是长驻资源：注册在 Cordis effect 上，插件禁用/重载时自动注销。
  // 启动是异步的，effect 的 disposer 同时处理“启动完成前就被卸载”的竞态。
  ctx.effect(() => {
    let disposed = false
    let handle

    startHotkey({
      onToggle: () => {
        togglePersistent()
      },
      // 急停通道失效 = 不能继续相信 persistent：先摘掉热键可用标记，再强制回 unauthorized。
      onUnavailable: (reason) => {
        hotkeyState.available = false
        hotkeyState.error = reason
        revokeAll('eventtap')
      },
    }).then((started) => {
      hotkeyState.available = started.available
      hotkeyState.error = started.error
      if (disposed) {
        void started.dispose()
      } else {
        handle = started
      }
    }).catch((error) => {
      hotkeyState.available = false
      hotkeyState.error = error instanceof Error ? error.message : String(error)
    })

    return () => {
      disposed = true
      if (handle !== undefined) {
        const current = handle
        handle = undefined
        return current.dispose()
      }
    }
  }, 'dsh-copilot-vision.hotkey')

  const plugin = createPlugin(defineTool, ctx, hotkeyState)
  for (const tool of plugin.tools) {
    ctx.tools.register(tool)
  }

  // 启动时异步清理一次超龄的差分/网格切片。fire-and-forget：清理失败绝不阻断插件加载，
  // 文件名过滤在结构上保证碰不到基准截图与审计日志（见 paths.js）。
  cleanupVisualFragments().catch(() => {})
}
