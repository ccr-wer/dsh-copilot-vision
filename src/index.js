// Vision-Pilot 插件入口（Cordis 适配层）。
//
// 三层结构：
//   actions.js  —— 业务逻辑（robot-ts + 授权闸门，可被回归测试直接调用）
//   plugin.js   —— 工具定义（createPluginSafe(defineTool, ctx, hotkeyState)，失败降级为空工具集）
//   index.js    —— 本文件：注入宿主 defineTool/ctx，并把热键生命周期交给 ctx.effect
//
// @deepseek-ai/dsh-tools 与 @deepseek-ai/cordis 由宿主以 peerDependency 提供
// （声明见 package.json），本地 node_modules 中不存在属正常现象。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPluginSafe } from './plugin.js'
import { startHotkey } from './hotkey.js'
import { togglePersistent, revokeAll } from './auth.js'
import { cleanupVisualFragments } from './paths.js'

export const name = 'dsh-copilot-vision'
export const inject = ['tools', 'userQuestions']

// 热键延后启动：robot-ts 的原生模块只在 Session.create() 时才被加载，而热键初始化
// 会创建一个 Session。把这段挪出 apply() 的同步路径，宿主启动的关键阶段就完全不碰
// 原生代码——原生段错误是唯一能穿透 Cordis 错误隔离、直接带走进程的风险面。
// 代价：加载后约 250ms 内 Shift+Space 尚未生效（期间 vp_auth_status 会如实说明）。
const HOTKEY_START_DELAY_MS = 250

/** 把插件自己的失败写进宿主日志。这是兜底路径的一部分，它自己绝不允许再抛。 */
function reportFailure(ctx, message, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const text = `dsh-copilot-vision: ${message}：${detail}`
  try {
    if (typeof ctx?.logger?.error === 'function') ctx.logger.error(text)
    else console.error(text)
  } catch {
    // 记日志都失败时保持沉默：此处唯一的职责是别把异常抛给宿主。
  }
}

export function apply(ctx) {
  const hotkeyState = {
    available: false,
    error: `热键将在插件加载后异步初始化（约 ${HOTKEY_START_DELAY_MS}ms）`,
  }

  // 热键是长驻资源：注册在 Cordis effect 上，插件禁用/重载时自动注销。
  // 启动是异步且延后的，effect 的 disposer 同时负责取消定时器、以及处理
  // “启动完成前就被卸载”的竞态。
  ctx.effect(() => {
    let disposed = false
    let handle
    let timer

    const begin = () => {
      timer = undefined
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
    }

    // unref：宿主若在热键起来之前就决定退出，这个定时器不该拖住宿主。
    timer = setTimeout(begin, HOTKEY_START_DELAY_MS)
    timer.unref?.()

    return () => {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (handle !== undefined) {
        const current = handle
        handle = undefined
        return current.dispose()
      }
    }
  }, 'dsh-copilot-vision.hotkey')

  const { plugin, error } = createPluginSafe(defineTool, ctx, hotkeyState)
  if (error !== undefined) {
    // 定义阶段失败（schema 非法、dsh-tools 改了签名等）：本轮不注册任何工具，
    // 但异常到此为止——兼容层回归的代价应该是「工具消失」，不是宿主退出。
    reportFailure(ctx, '工具定义失败，本次加载未注册任何工具', error)
  }

  for (const tool of plugin.tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      // 单条注册失败（重名、被宿主 schema 校验驳回）只损失这一个工具，其余照常。
      reportFailure(ctx, `工具 ${tool.name} 注册失败，其余工具继续注册`, error)
    }
  }

  // 启动时异步清理一次超龄的差分/网格切片。fire-and-forget：清理失败绝不阻断插件加载，
  // 文件名过滤在结构上保证碰不到基准截图与审计日志（见 paths.js）。
  cleanupVisualFragments().catch(() => {})
}
