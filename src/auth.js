// Vision-Pilot 授权状态机（宿主无关，纯内存单例）。
//
// 授权模型（V1.3）：只有两种权限结论 + 一种等待态。
//   unauthorized        未授权，一切鼠标与键盘操作直接拦截
//   pending-persistent  已请求持续授权、等待人类在卡片上确认
//   persistent          持续授权中，鼠标与键盘一律直接放行
//
// 铁律：授权只由人的明确动作改变——按 Shift+Space，或在卡片上确认 persistent 请求。
// 不由时钟改变：没有任何到期判断，也不返回 remainingMs。
//
// V1.3 取消了两样东西，别再引回来：
//   - 单次授权（pending-once / authorized-once / consumeOnce）：点「允许」会把焦点抢回
//     DSH 窗口，紧接着的注入落进错误窗口，是实测确认的故障来源。
//   - 键盘独立通道（keyboardGranted / checkCanKeyboard / consumeKeyboard）：键盘与鼠标
//     共用 checkCanClick()，persistent 下一律放行，unauthorized 下一律拦截。
//
// 每次授权动作与每次被拒绝/放行的注入都追加审计记录，见 src/audit.js。
//
// 竞态约定：pendingRequest 的生命周期绑一个 AbortController。任何清空 pending 的动作
// （热键接管/撤销、cancelPending）都必须 abort 它，让调用方那侧「还在等人点卡片」的
// promise 立刻收到 AUTH_CANCELLED 并正常返回，而不是等那个答案迟到后撞进 confirmPending()。
// confirmPending 只认自己那一次的 requestId：对不上就是迟到的答案，安全丢弃。

import { logState } from './audit.js'

const state = {
  persistent: false,
  /** @type {{requestId: string, mode: 'persistent', requestedAt: number, controller: AbortController} | null} */
  pendingRequest: null,
  requestSeq: 0,
  // 放行态的代数：每次 persistent 翻转 +1。动作在 checkCanClick() 放行时记下它，
  // 注入前再比一次——即使中途「撤销又立刻授权」，旧动作也不会带着旧授权继续飞。
  epoch: 0,
}

/** 当前授权状态（只读快照，不含内部的 AbortController）。 */
export function getStatus() {
  // 待确认请求独立于 state 展示：persistent 在位时也可能挂着一张卡片，
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
    return { state: 'persistent', ...pending }
  }
  if (state.pendingRequest !== null) {
    return { state: 'pending-persistent', ...pending }
  }
  return { state: 'unauthorized' }
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
 * 登记一个持续授权请求，不改变放行状态。
 * 返回的 signal 会在该请求被热键接管或被取消时 abort，调用方用它把「等人回答」的
 * promise 换成一个可取消的等待。
 */
function startRequest() {
  const previousState = getStatus().state
  // 连着发两次请求时，前一张卡片不能变成悬空的：它一被答就撞上「已丢弃」，
  // 所以这里同样要 abort 掉，让前一次等待立刻正常返回。
  clearPending({ code: 'AUTH_CANCELLED', reason: '被新的授权请求顶替' })
  state.requestSeq += 1
  const requestId = `auth-${state.requestSeq}`
  const controller = new AbortController()
  state.pendingRequest = { requestId, mode: 'persistent', requestedAt: Date.now(), controller }
  audit('requestAuth', 'tool', previousState, { requestId, mode: 'persistent' })
  return { requestId, signal: controller.signal, status: getStatus() }
}

/**
 * 模型侧发起持续授权请求。只登记 pendingRequest，不改变放行状态。
 * mode 只为接口稳定保留：V1.3 起只接受 'persistent'，other 值直接报错。
 */
export function requestAuth(mode = 'persistent') {
  if (mode !== 'persistent') {
    throw new Error(`requestAuth: mode 只支持 persistent（V1.3 已取消单次授权），收到 ${mode}`)
  }
  return startRequest()
}

/**
 * 人侧确认：pending-persistent → persistent。
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
  state.persistent = true
  state.epoch += 1
  request.controller.abort({ code: 'AUTH_CANCELLED', reason: '已由人确认' })
  audit('confirmPending', 'user-question', previousState, { mode: request.mode, requestId })
  return { ...getStatus(), confirmed: true }
}

/** 取消待确认请求。persistent 不受影响（它只能由热键撤销）。 */
export function cancelPending() {
  const previousState = getStatus().state
  clearPending({ code: 'AUTH_CANCELLED', reason: '已取消' })
  audit('cancelPending', 'tool', previousState)
  return getStatus()
}

/**
 * 热键调用，也是 persistent 唯一的入口与出口：
 * persistent 中 → 撤销回 unauthorized；其余状态 → 进入 persistent（清 pending）。
 */
export function togglePersistent(source = 'hotkey') {
  const previousState = getStatus().state
  if (state.persistent) {
    state.persistent = false
    clearPending({ code: 'AUTH_CANCELLED', reason: '热键撤销' })
  } else {
    state.persistent = true
    clearPending({ code: 'AUTH_CANCELLED', reason: '热键接管' })
  }
  state.epoch += 1
  audit('togglePersistent', source, previousState)
  return getStatus()
}

/**
 * 系统侧的强制回收：EventTap 失效时调用，无条件回到 unauthorized。
 * 与 togglePersistent 的区别是它只会撤销、不会开启；pending 一并清掉，
 * 因为这个状态机已经没有可信的人类急停通道了（fail-closed）。
 */
export function revokeAll(reason = 'system') {
  const previousState = getStatus().state
  state.persistent = false
  clearPending({ code: 'AUTH_CANCELLED', reason })
  state.epoch += 1
  audit('revokeAll', 'system', previousState, { reason })
  return getStatus()
}

/** 当前放行态的代数（见 state.epoch 的注释）。 */
export function getAuthEpoch() {
  return state.epoch
}

/**
 * 鼠标与键盘共用的放行判断（不消费、不改状态）。
 * 键盘不再有独立通道：persistent 下鼠标与键盘一律放行。
 */
export function checkCanClick() {
  if (state.persistent) {
    return { allowed: true, reason: '持续授权有效' }
  }
  if (state.pendingRequest !== null) {
    return { allowed: false, reason: '授权请求待确认' }
  }
  return { allowed: false, reason: '未授权' }
}

/** 测试专用：重置为未授权。 */
export function _resetForTests() {
  state.persistent = false
  clearPending({ code: 'AUTH_CANCELLED', reason: '测试重置' })
  state.requestSeq = 0
  state.epoch += 1
}

/** 测试专用：读内部标志位（getStatus 看不到 persistent 期间挂着的 pending 详情之外的东西）。 */
export function _peekForTests() {
  return {
    persistent: state.persistent,
    hasPending: state.pendingRequest !== null,
  }
}
