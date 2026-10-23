// Vision-Pilot 授权状态机（宿主无关，纯内存单例）。
//
// 原则：授权状态只由人的明确动作改变，不由时钟改变。
// 因此本文件没有任何到期判断，也不返回 remainingMs —— persistent 一经进入就一直有效，
// 直到用户再次按 Shift+Space 撤销。
//
// 五种 state：
//   unauthorized        未授权
//   pending-once        已请求单次授权、等待人类确认（带 pendingRequest）
//   authorized-once     已确认、等待下一次点击消费（无 pendingRequest）
//   pending-persistent  已请求持续授权、等待人类确认
//   persistent          持续授权中，无到期
//
// 分工：checkCanClick() 只看是否放行、不改变状态；consumeOnce() 才真正消费
// authorized-once。因此坐标越界等失败路径不会浪费一次单次授权。
//
// 键盘另有通道（keyboardGranted）：持续授权对鼠标有效、对键盘永远无效。
// 键盘每次输入/按键都必须由人单独点头（pendingRequest.mode='keyboard' → 确认后
// 置 keyboardGranted），消费一次即失效。这是「点击可以享受持续授权的便利，
// 键盘永远必须人类点头」的实现落点。
//
// 每次动作（含被拒绝的点击）都会追加一条审计记录，见 src/audit.js。
//
// 竞态约定（P0 修复）：pendingRequest 的生命周期绑一个 AbortController。任何清空 pending 的
// 动作（热键接管/撤销、cancelPending）都必须 abort 它，让调用方那侧「还在等人点卡片」的
// promise 立刻收到 AUTH_CANCELLED 并正常返回，而不是等那个答案迟到后撞进 confirmPending()。
// confirmPending 只认自己那一次的 requestId：对不上就是迟到的答案，安全丢弃。

import { logState } from './audit.js'

const state = {
  persistent: false,
  onceGranted: false,
  /** 键盘一次性放行：人单独点过头才为真，消费一次即清。持续授权永远不会置它。 */
  keyboardGranted: false,
  /** @type {{requestId: string, mode: 'once'|'persistent'|'keyboard', requestedAt: number, controller: AbortController} | null} */
  pendingRequest: null,
  requestSeq: 0,
}

/** 当前授权状态（只读快照，不含内部的 AbortController）。 */
export function getStatus() {
  // 待确认请求独立于 state 展示：persistent 在位时也可能挂着一张卡片（比如键盘确认卡），
  // 藏起来的话人/model 都看不到「还有一张卡在等」。
  const pending = state.pendingRequest === null
    ? {}
    : {
      pendingRequest: {
        requestId: state.pendingRequest.requestId,
        mode: state.pendingRequest.mode,
        requestedAt: state.pendingRequest.requestedAt,
      },
    }
  if (state.persistent) {
    return { state: 'persistent', keyboardAuthorized: state.keyboardGranted, ...pending }
  }
  if (state.pendingRequest !== null) {
    // keyboard 也是「一次性授权待确认」，靠 pendingRequest.mode 区分具体是哪一种
    return {
      state: state.pendingRequest.mode === 'persistent' ? 'pending-persistent' : 'pending-once',
      keyboardAuthorized: state.keyboardGranted,
      ...pending,
    }
  }
  if (state.onceGranted) {
    return { state: 'authorized-once', keyboardAuthorized: state.keyboardGranted }
  }
  return { state: 'unauthorized', keyboardAuthorized: state.keyboardGranted }
}

function audit(action, source, previousState, extra) {
  logState(action, source, previousState, getStatus().state, extra)
}

/**
 * 清空待确认请求并通知调用方「这次请求已经不存在了」。
 * 必须先置空再 abort：abort 是同步派发事件的，置空后监听方读到的状态才是终态。
 */
function clearPending(reason) {
  const pending = state.pendingRequest
  if (pending === null) return
  state.pendingRequest = null
  pending.controller.abort(reason)
}

/**
 * 登记一个待确认请求（三种 mode：once / persistent / keyboard），不改变放行状态。
 * 返回的 signal 会在该请求被热键接管或被取消时 abort，调用方用它把「等人回答」的
 * promise 换成一个可取消的等待。
 */
function startRequest(mode) {
  const previousState = getStatus().state
  // 连着发两次请求时，前一张卡片不能变成悬空的：它一被答就撞上「已丢弃」，
  // 所以这里同样要 abort 掉，让前一次等待立刻正常返回。
  clearPending({ code: 'AUTH_CANCELLED', reason: '被新的授权请求顶替' })
  state.requestSeq += 1
  const requestId = `auth-${state.requestSeq}`
  const controller = new AbortController()
  state.pendingRequest = { requestId, mode, requestedAt: Date.now(), controller }
  audit('requestAuth', 'tool', previousState, { requestId, mode })
  return { requestId, signal: controller.signal, status: getStatus() }
}

/**
 * 模型侧发起授权请求。只登记 pendingRequest，不改变放行状态。
 */
export function requestAuth(mode) {
  if (mode !== 'once' && mode !== 'persistent') {
    throw new Error(`requestAuth: mode 必须是 once 或 persistent，收到 ${mode}`)
  }
  return startRequest(mode)
}

/**
 * 键盘专用的授权请求。与鼠标授权彻底分开：确认后只置 keyboardGranted
 * （一次性键盘放行），不产生任何鼠标放行；persistent 也永远不会替代它。
 */
export function requestKeyboardAuth() {
  return startRequest('keyboard')
}

/**
 * 人侧确认：pending-once → authorized-once；pending-persistent → persistent。
 * 只认 requestId 对应的那一次请求。对不上（已被热键接管或已取消）时不改状态、
 * 不写审计、不抛错，返回 confirmed:false —— 迟到的答案本来就该被丢弃。
 */
export function confirmPending(requestId) {
  const request = state.pendingRequest
  if (request === null || request.requestId !== requestId) {
    return { ...getStatus(), confirmed: false }
  }
  const previousState = getStatus().state
  state.pendingRequest = null
  if (request.mode === 'once') {
    state.onceGranted = true
  } else if (request.mode === 'keyboard') {
    // 键盘只拿到「一次键盘放行」；鼠标的授权状态一点没动。
    state.keyboardGranted = true
  } else {
    state.persistent = true
    state.onceGranted = false
  }
  request.controller.abort({ code: 'AUTH_CANCELLED', reason: '已由人确认' })
  audit('confirmPending', 'user-question', previousState, { mode: request.mode, requestId })
  return { ...getStatus(), confirmed: true }
}

/** 取消待确认请求与单次授权。persistent 不受影响（它只能由热键撤销）。 */
export function cancelPending() {
  const previousState = getStatus().state
  state.onceGranted = false
  state.keyboardGranted = false
  clearPending({ code: 'AUTH_CANCELLED', reason: '已取消' })
  audit('cancelPending', 'tool', previousState)
  return getStatus()
}

/**
 * 热键调用。热键优先级最高，且是 persistent 唯一的入口与出口：
 * persistent 中 → 撤销回 unauthorized；其余状态 → 进入 persistent（清 pending/authorized-once）。
 *
 * 撤销分支必须全清：persistent 期间人确认的「允许一次」会置 onceGranted，而 persistent 下的点击
 * 走 persistent 放行分支、不消费它。若撤销时不清 onceGranted，撤销后状态就成了 authorized-once，
 * 下一次点击仍会静默放行 —— 人以为已经收干净了。
 */
export function togglePersistent(source = 'hotkey') {
  const previousState = getStatus().state
  if (state.persistent) {
    state.persistent = false
    state.onceGranted = false
    state.keyboardGranted = false
    clearPending({ code: 'AUTH_CANCELLED', reason: '热键撤销' })
  } else {
    state.persistent = true
    state.onceGranted = false
    state.keyboardGranted = false
    clearPending({ code: 'AUTH_CANCELLED', reason: '热键接管' })
  }
  audit('togglePersistent', source, previousState)
  return getStatus()
}

/**
 * 消费一次放行。持续授权下放行且不改变状态；单次授权放行即清空。
 * 返回 { allowed, mode?, reason? }。
 */
export function consumeOnce() {
  const previousState = getStatus().state
  if (state.persistent) {
    audit('consumeOnce', 'tool', previousState, { allowed: true, mode: 'persistent' })
    return { allowed: true, mode: 'persistent' }
  }
  if (state.onceGranted) {
    state.onceGranted = false
    audit('consumeOnce', 'tool', previousState, { allowed: true, mode: 'once' })
    return { allowed: true, mode: 'once' }
  }
  audit('consumeOnce', 'tool', previousState, {
    allowed: false,
    reason: state.pendingRequest !== null ? '授权请求待确认' : '未授权',
  })
  return {
    allowed: false,
    reason: state.pendingRequest !== null ? '授权请求待确认' : '未授权',
  }
}

/** vp_click 的放行判断（不消费）。 */
export function checkCanClick() {
  if (state.persistent) {
    return { allowed: true, reason: '持续授权有效' }
  }
  if (state.onceGranted) {
    return { allowed: true, reason: '单次授权待使用' }
  }
  if (state.pendingRequest !== null) {
    return { allowed: false, reason: '授权请求待确认' }
  }
  return { allowed: false, reason: '未授权' }
}

/**
 * 键盘的放行判断（不消费）。
 *
 * 这里是「键盘极度安全闸门」的落点：persistent 不在这里出现。
 * 持续授权只对鼠标有效；键盘每一次输入/按键都必须有一次独立的、属于它自己的
 * 人类确认（pendingRequest.mode='keyboard' → 确认后置 keyboardGranted）。
 * 所以持续授权期间调用键盘工具，永远走「未授权」分支。
 */
export function checkCanKeyboard() {
  if (state.keyboardGranted) {
    return { allowed: true, reason: '键盘单次授权待使用' }
  }
  if (state.pendingRequest !== null && state.pendingRequest.mode === 'keyboard') {
    return { allowed: false, reason: '键盘授权请求待确认' }
  }
  if (state.pendingRequest !== null) {
    return { allowed: false, reason: '授权请求待确认' }
  }
  return { allowed: false, reason: '未授权（键盘操作必须逐次经人类确认，持续授权也不例外）' }
}

/**
 * 消费一次键盘放行：keyboardGranted 置位时消费并清空。
 * 一次性：消费完就不再放行下一次键盘操作。
 */
export function consumeKeyboard(extra = {}) {
  const previousState = getStatus().state
  if (state.keyboardGranted) {
    state.keyboardGranted = false
    audit('consumeKeyboard', 'tool', previousState, { allowed: true, mode: 'keyboard', ...extra })
    return { allowed: true, mode: 'keyboard' }
  }
  const reason = state.pendingRequest !== null ? '授权请求待确认' : '未授权'
  audit('consumeKeyboard', 'tool', previousState, { allowed: false, reason, ...extra })
  return { allowed: false, reason }
}

/** 测试专用：重置为未授权。 */
export function _resetForTests() {
  state.persistent = false
  state.onceGranted = false
  state.keyboardGranted = false
  clearPending({ code: 'AUTH_CANCELLED', reason: '测试重置' })
  state.requestSeq = 0
}

/**
 * 测试专用：读内部标志位。persistent 期间 onceGranted 是否还挂着，
 * getStatus() 看不出来（persistent 优先返回 'persistent'），只能从这里取证。
 */
export function _peekForTests() {
  return {
    persistent: state.persistent,
    onceGranted: state.onceGranted,
    keyboardGranted: state.keyboardGranted,
    hasPending: state.pendingRequest !== null,
  }
}
