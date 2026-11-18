// 平台差异只集中在这里：其余模块不直接读 process.platform。
//
// 这些函数只生成「给人看的授权提示」，不作为功能开关 —— 某项能力是否可用一律由
// robot-ts 运行时上报的 capabilities 决定。把平台假设变成硬编码分支，正是当初
// 「仅 Windows」这种表述容易误导人的原因。

const MACOS = 'darwin'

// macOS 的授权闸门是逐应用（TCC）：授给 Terminal，VS Code 里的宿主仍然没有。
// 这两句话必须点明「宿主应用」和「重启进程」，否则人类会以为我们已经拿到了权限。
const MAC_HINTS = {
  accessibility:
    'macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」中勾选宿主应用（如 Terminal / DSH），' +
    '授权后重启宿主进程；未授权时全局钩子建不起来，Shift+Space 急停也随之不存在',
  screenRecording:
    'macOS 需在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选宿主应用（如 Terminal / DSH），' +
    '授权后必须重启宿主进程才会生效',
}

/** 权限类失败的附加指引；非 macOS 返回 null（Windows 没有这种逐应用授权闸门）。 */
export function permissionHint(kind, platform = process.platform) {
  if (platform !== MACOS) return null
  return MAC_HINTS[kind] ?? null
}

/** 把提示拼到错误消息后面；hint 为空时原样返回。 */
export function withHint(message, hint) {
  return hint ? `${message}（${hint}）` : message
}
