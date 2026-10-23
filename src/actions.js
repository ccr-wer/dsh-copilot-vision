// Vision-Pilot 工具的业务逻辑（宿主无关）。
// 本文件只依赖 robot-ts 与 node 内置模块，不 import @deepseek-ai/dsh-tools / cordis，
// 因此 test-mvp.mjs 可以直接调用来做回归，不需要 DSH 宿主。

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { physicalToLogical, relativeToPhysical } from './coords.js'
import { parseKeySpec, resolveUnicodeChar } from './keys.js'
import { loadRobotTs } from './robot-ts.js'
import { checkCanClick, checkCanKeyboard, consumeKeyboard, consumeOnce, getStatus } from './auth.js'
import { logState } from './audit.js'
import { resolveShotsDir } from './paths.js'
import { get, nextShotId, record } from './shot-index.js'

// 目录解析集中在 src/paths.js（截图与审计日志共用同一个目录）。
// 之前用相对 src/ 的 .vp-shots，tarball 安装后会落进
// node_modules/vision-pilot/.vp-shots —— 用户找不到，重装即丢。

/** 主屏全屏截图，落盘为 PNG。每次调用新建会话，用完即 dispose（MVP 不做会话复用）。 */
export async function screenshotAction() {
  const { Session } = loadRobotTs()
  const session = await Session.create()
  try {
    if (!session.capabilities.canCaptureScreen) {
      throw new Error('当前宿主环境不支持屏幕捕获（canCaptureScreen=false）')
    }
    const primary = await session.screen.primaryMonitor()
    const img = await session.screen.captureMonitor(primary.id)

    const dir = resolveShotsDir()
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `vp-shot-${stamp}.png`)
    await img.savePng(path)

    const { width, height } = primary.physicalBounds.size
    const shotId = nextShotId()
    record(shotId, {
      path,
      width: img.width,
      height: img.height,
      scaleFactor: primary.scaleFactor,
      physicalBounds: { width, height },
    })
    return {
      shotId,
      path,
      width: img.width,
      height: img.height,
      scaleFactor: primary.scaleFactor,
      physicalBounds: { width, height },
    }
  } finally {
    await session.dispose()
  }
}

/**
 * 旁白归一化：模型给的 thought 原样回显；没给（或只给空白）时用一句默认描述兜底。
 * 旁白是给人看的进度说明，不参与任何判定，所以缺失不该让操作失败。
 */
export function normalizeThought(thought, fallback) {
  if (typeof thought === 'string' && thought.trim() !== '') {
    return thought.trim()
  }
  return fallback
}

/** 按物理像素坐标点击一次。x/y 来自 vp_screenshot 的图像坐标系；授权闸门先于坐标校验。 */
export async function clickAction(args = {}) {
  const { x, y } = args
  const gate = checkCanClick()
  if (!gate.allowed) {
    // 闸门在坐标校验之前，所以这里的 x/y 还没验过；只在确认是数值时才写进审计，
    // 避免把任意入参当成坐标记录。logical 此刻拿不到 scaleFactor（不为此新建会话），故省略。
    const state = getStatus().state
    logState('clickDenied', 'tool', state, state, {
      reason: gate.reason,
      ...(Number.isFinite(x) && Number.isFinite(y) ? { physical: { x, y } } : {}),
    })
    throw new Error(`vp_click 未获授权：${gate.reason}。可调用 vp_request_auth 请求，或按 Shift+Space 进入持续授权。`)
  }
  const { Session, MouseButton } = loadRobotTs()
  const buttons = {
    left: MouseButton.Left,
    right: MouseButton.Right,
    middle: MouseButton.Middle,
  }
  const { button = 'left' } = args

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`vp_click: x/y 必须是有限数字，收到 x=${x}, y=${y}`)
  }
  if (x < 0 || y < 0) {
    throw new Error(`vp_click: 坐标不能为负数，收到 x=${x}, y=${y}`)
  }
  if (!Object.hasOwn(buttons, button)) {
    throw new Error(`vp_click: button 必须是 left|right|middle，收到 ${button}`)
  }

  const session = await Session.create()
  try {
    if (!session.capabilities.canInjectMouse) {
      throw new Error('当前宿主环境不支持鼠标注入（canInjectMouse=false）')
    }
    const primary = await session.screen.primaryMonitor()
    const { width, height } = primary.physicalBounds.size

    if (x >= width || y >= height) {
      throw new Error(
        `vp_click: 物理坐标 (${x}, ${y}) 超出主屏范围 ` +
        `0 <= x < ${width}, 0 <= y < ${height}（越界不会被静默夹到边界）`,
      )
    }

    const logical = physicalToLogical({ x, y }, primary.scaleFactor)
    // 参数与越界都通过后才消费放行，避免一次失败的调用浪费单次授权。
    const consumed = consumeOnce()
    if (!consumed.allowed) {
      throw new Error(`vp_click 未获授权：${consumed.reason}。可调用 vp_request_auth 请求，或按 Shift+Space 进入持续授权。`)
    }
    await session.mouse.move(logical)
    await session.mouse.click(buttons[button])

    return {
      thought: normalizeThought(args.thought, `点击屏幕物理坐标 (${x}, ${y})`),
      clicked: true,
      physical: { x, y },
      logical,
      button,
    }
  } finally {
    await session.dispose()
  }
}

/**
 * 在当前焦点位置输入文本。绝对不包含回车：回车只能由 vp_key 单独触发。
 *
 * 授权闸门与鼠标点击彻底分开：persistent 也不放行键盘，必须有一次针对本次输入的
 * 人类确认（keyboardGranted），消费一次即失效。闸门顺序：授权 → 参数 → 消费，
 * 所以无效入参不会浪费那张一次性授权。
 */
export async function typeAction(args = {}) {
  const gate = checkCanKeyboard()
  if (!gate.allowed) {
    const state = getStatus().state
    logState('keyboardDenied', 'tool', state, state, { reason: gate.reason, tool: 'vp_type' })
    throw new Error(
      `vp_type 未获授权：${gate.reason}。键盘操作必须逐次经人类确认，持续授权也不例外。`,
    )
  }

  const { text } = args
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`vp_type: text 必须是非空字符串，收到 ${typeof text === 'string' ? '空串' : typeof text}`)
  }

  const { Session } = loadRobotTs()
  const session = await Session.create()
  try {
    if (!session.capabilities.canInjectKeyboard) {
      throw new Error('当前宿主环境不支持键盘注入（canInjectKeyboard=false）')
    }
    if (!session.capabilities.canTypeUnicode) {
      throw new Error('当前宿主环境不支持 Unicode 文本注入（canTypeUnicode=false）')
    }
    const consumed = consumeKeyboard({ tool: 'vp_type', chars: text.length })
    if (!consumed.allowed) {
      throw new Error(
        `vp_type 未获授权：${consumed.reason}。键盘操作必须逐次经人类确认，持续授权也不例外。`,
      )
    }
    // robot-ts 的 typeText 走 KEYEVENTF_UNICODE 直接注入码点，与键盘布局无关，
    // 中文/emoji 都能原样打出来，不需要剪贴板中转。
    await session.keyboard.typeText(text)
    return {
      typed: text,
      method: 'unicode',
      chars: text.length,
    }
  } finally {
    await session.dispose()
  }
}

/**
 * 只解析按键写法，不碰屏幕、不碰授权。
 * 供工具层在弹卡片之前先验一遍：无效键名不该先打扰人再报错。
 */
export function describeKeySpec(key) {
  const { Key, Modifier } = loadRobotTs()
  const spec = parseKeySpec(key, Key, Modifier)
  if (!Object.values(Key).includes(spec.code)) {
    throw new Error(`vp_key: 键码 ${spec.code} 不在 robot-ts 的键表里（上游键表可能已变更）`)
  }
  return spec
}

/**
 * 发送一次按键或组合键（如 enter / tab / esc / ctrl+c）。
 * 授权闸门与 vp_type 完全相同：persistent 永不直接放行键盘。
 *
 * 注入通道按键的性质分流（本机实测）：
 *   - 无修饰键的字符键（字母/数字/符号）→ Unicode 直注。扫描码通道会经过系统输入法，
 *     中文输入法实测会吞掉字母键（按下不落字，下一次 Enter 才吐幽灵字符）、把引号改成中文弯引号。
 *   - 其余（控制键、space、带 ctrl/alt/meta 的组合键）→ 真实扫描码，
 *     这样组合键语义是真的（Ctrl+V 实测能粘上），space 也能激活聚焦的按钮。
 */
export async function keyAction(args = {}) {
  const gate = checkCanKeyboard()
  if (!gate.allowed) {
    const state = getStatus().state
    logState('keyboardDenied', 'tool', state, state, { reason: gate.reason, tool: 'vp_key' })
    throw new Error(
      `vp_key 未获授权：${gate.reason}。键盘操作必须逐次经人类确认，持续授权也不例外。`,
    )
  }

  const { key } = args
  const { Session, Key, Modifier } = loadRobotTs()
  const spec = parseKeySpec(key, Key, Modifier)
  const unicodeChar = resolveUnicodeChar(spec)

  const session = await Session.create()
  try {
    if (!session.capabilities.canInjectKeyboard) {
      throw new Error('当前宿主环境不支持键盘注入（canInjectKeyboard=false）')
    }
    if (!Object.values(Key).includes(spec.code)) {
      throw new Error(`vp_key: 键码 ${spec.code} 不在 robot-ts 的键表里（上游键表可能已变更）`)
    }
    if (unicodeChar !== null && !session.capabilities.canTypeUnicode) {
      throw new Error('当前宿主环境不支持 Unicode 文本注入（canTypeUnicode=false）')
    }
    const consumed = consumeKeyboard({ tool: 'vp_key', key: spec.spec })
    if (!consumed.allowed) {
      throw new Error(
        `vp_key 未获授权：${consumed.reason}。键盘操作必须逐次经人类确认，持续授权也不例外。`,
      )
    }
    if (unicodeChar !== null) {
      await session.keyboard.typeChar(unicodeChar.codePointAt(0))
    } else {
      await session.keyboard.tap(spec.code, spec.modifiers)
    }
    return {
      key: spec.spec,
      keyName: spec.keyName,
      modifiers: spec.modifiers,
      method: unicodeChar !== null ? 'unicode' : 'scancode',
    }
  } finally {
    await session.dispose()
  }
}

/**
 * 把「shotId + 1-based region 序号 + 相对百分比」解析成全局物理坐标。
 * 只查索引与做算数，不碰屏幕、不碰授权，所以可以被测试直接调用。
 */
export function resolveRelativeTarget({ shotId, index, xPercent, yPercent }) {
  if (!Number.isInteger(shotId)) {
    throw new Error(`vp_click_relative: shotId 必须是整数，收到 ${shotId}`)
  }
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`vp_click_relative: index 必须是 >=1 的整数（1-based），收到 ${index}`)
  }
  const meta = get(shotId)
  if (meta === undefined) {
    throw new Error(`vp_click_relative: shotId ${shotId} 不存在，可先用 vp_screenshot 或 vp_screenshot_diff 生成`)
  }
  if (!Array.isArray(meta.regions) || meta.regions.length === 0) {
    throw new Error(
      `vp_click_relative: shotId ${shotId} 没有差分区域；只有 vp_screenshot_diff / vp_wait_change ` +
      '产出的 currentShotId 才能相对点击（普通 vp_screenshot 没有 region）',
    )
  }
  if (index > meta.regions.length) {
    throw new Error(
      `vp_click_relative: index ${index} 超出范围，shotId ${shotId} 只有 ${meta.regions.length} 个区域（1..${meta.regions.length}）`,
    )
  }
  const bbox = meta.regions[index - 1].bbox
  return { bbox, physical: relativeToPhysical(bbox, xPercent, yPercent) }
}

/**
 * 在差分区域内部按相对位置点击。授权闸门与 vp_click 保持同一顺序：
 * 授权 → 参数合法性 → 越界 → 消费，所以未授权时不会读索引、不会新建 robot-ts 会话。
 */
export async function clickRelativeAction(args = {}) {
  const gate = checkCanClick()
  if (!gate.allowed) {
    const state = getStatus().state
    logState('clickDenied', 'tool', state, state, { reason: gate.reason, tool: 'vp_click_relative' })
    throw new Error(
      `vp_click_relative 未获授权：${gate.reason}。可调用 vp_request_auth 请求，或按 Shift+Space 进入持续授权。`,
    )
  }

  const { shotId, index, xPercent, yPercent, button = 'left' } = args
  const { bbox, physical } = resolveRelativeTarget({ shotId, index, xPercent, yPercent })
  const clicked = await clickAction({ x: physical.x, y: physical.y, button, thought: args.thought })
  return {
    thought: clicked.thought,
    clicked: true,
    shotId,
    index,
    bbox,
    relative: { xPercent, yPercent },
    physical: clicked.physical,
    logical: clicked.logical,
    button: clicked.button,
  }
}
