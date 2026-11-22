// 平台差异只集中在这里：其余模块不直接读 process.platform。
//
// 这些函数只生成「给人看的授权/环境提示」，不作为功能开关 —— 某项能力是否可用一律由
// robot-ts 运行时上报的 capabilities 决定。把平台假设变成硬编码分支，正是当初
// 「仅 Windows」这种表述容易误导人的原因。
//
// kind 的含义是「缺的是什么能力」，不是「哪个系统要什么权限」：
//   globalHook      —— 全局低层键盘钩子（Shift+Space 急停通道）
//   capture         —— 屏幕捕获
//   absolutePointer —— 绝对坐标定位（vp_click / vp_click_relative 的落点基础）

const HINTS = {
  // macOS 的授权闸门是逐应用（TCC）：授给 Terminal，VS Code 里的宿主仍然没有。
  // 这两句话必须点明「宿主应用」和「重启进程」，否则人类会以为我们已经拿到了权限。
  darwin: {
    globalHook:
      'macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」中勾选宿主应用（如 Terminal / DSH），' +
      '授权后重启宿主进程；未授权时全局钩子建不起来，Shift+Space 急停也随之不存在',
    capture:
      'macOS 需在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选宿主应用（如 Terminal / DSH），' +
      '授权后必须重启宿主进程才会生效',
  },
  // Linux 的能力面由会话类型决定：X11 走 XTest + XRandR + XRecord 全量可用；
  // Wayland 只有 uinput（键盘 + 相对鼠标），没有截屏，也没有 XRecord 全局钩子。
  linux: {
    globalHook:
      'Linux 下全局钩子依赖 X11 的 XRecord；Wayland 会话或没有 X11 显示时 Shift+Space 急停不可用。' +
      '若改用 uinput 注入，还需要 /dev/uinput 的读写权限（input 组或 udev 规则）',
    capture:
      'Linux 需要 X11 会话（XTest + XRandR + XRecord）；Wayland 会话没有全局截屏后端，' +
      '请在登录界面选择 Xorg/X11 会话后重试',
    absolutePointer:
      'Linux 的 uinput 后端只支持相对鼠标移动；绝对落点需要 X11 会话（XTest）',
  },
}

/** 某项能力缺失时的附加指引；当前平台没有对应文案时返回 null。 */
export function permissionHint(kind, platform = process.platform) {
  return HINTS[platform]?.[kind] ?? null
}

/** 把提示拼到错误消息后面；hint 为空时原样返回。 */
export function withHint(message, hint) {
  return hint ? `${message}（${hint}）` : message
}
