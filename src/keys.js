// 按键写法解析：把 "enter" / "ctrl+c" / "f5" 这类人类写法翻译成 robot-ts 的 Key 码与修饰键。
//
// 键码不在这里写死：直接从 robot-ts 导出的 Key 枚举反查（枚举名即官方键名），
// 别名表只补口语写法（esc / del / pgup / 数字键…）。这样上游改键值时我们跟着走，
// 不会像写死常量那样悄悄注入错键。
//
// 解析是纯函数：Key/Modifier 枚举由调用方（actions.js）从 robot-ts 取出后传入，
// 这样本模块既不 import native，也不依赖宿主。

// 别名 → robot-ts Key 枚举名（小写形式）
const KEY_ALIASES = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  up: 'uparrow',
  down: 'downarrow',
  left: 'leftarrow',
  right: 'rightarrow',
  plus: 'equal',
  1: 'digit1',
  2: 'digit2',
  3: 'digit3',
  4: 'digit4',
  5: 'digit5',
  6: 'digit6',
  7: 'digit7',
  8: 'digit8',
  9: 'digit9',
  0: 'digit0',
  '-': 'minus',
  '=': 'equal',
  '[': 'leftbracket',
  ']': 'rightbracket',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'quote',
  '`': 'grave',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
}

// 别名 → robot-ts Modifier 枚举值
const MODIFIER_ALIASES = {
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  win: 'Meta',
  super: 'Meta',
}

// 字符键 → 它在文本里对应的字符。
//
// 只给「无修饰键的字符键」准备：这类键改走 Unicode 直注（见 resolveUnicodeChar）。
// 原因是 robot-ts 的按键注入走 KEYEVENTF_SCANCODE，会经过系统输入法 ——
// 本机中文输入法实测会把字母键吞成拼音组合串（按下不落字，直到下一次 Enter 才吐出幽灵字符），
// 还会把引号改写成中文弯引号。Unicode 直注绕开输入法，字符原样落下。
//
// space 不在表里：扫描码空格实测正常，而且只有真实按键才能激活聚焦的按钮。
const CHARACTER_KEYS = {
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i', j: 'j',
  k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', p: 'p', q: 'q', r: 'r', s: 's', t: 't',
  u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
  digit1: '1', digit2: '2', digit3: '3', digit4: '4', digit5: '5',
  digit6: '6', digit7: '7', digit8: '8', digit9: '9', digit0: '0',
  minus: '-', equal: '=', leftbracket: '[', rightbracket: ']', backslash: '\\',
  nonushash: '#', semicolon: ';', quote: "'", grave: '`', comma: ',', period: '.', slash: '/',
}

export const MODIFIER_NAMES = ['ctrl', 'shift', 'alt', 'meta']

/** Key 枚举 → 小写名到码值的索引（枚举成员名即官方键名）。 */
function keyIndex(keyEnum) {
  const index = new Map()
  for (const [name, value] of Object.entries(keyEnum)) {
    if (typeof value === 'number') index.set(name.toLowerCase(), value)
  }
  return index
}

/**
 * 解析按键写法。
 * 返回 { code, keyName, modifiers, spec }：
 *   code      robot-ts 的 Key 码（数字）
 *   keyName   规范化的主键名（robot-ts 枚举名）
 *   modifiers 修饰键枚举值数组，如 ['Control']
 *   spec      原样回显的写法
 * 解析失败一律抛错，错误文案里带上可用的修饰键名。
 */
export function parseKeySpec(spec, keyEnum, modifierEnum) {
  if (typeof spec !== 'string') {
    throw new Error(`vp_key: key 必须是字符串，收到 ${spec === null ? 'null' : typeof spec}`)
  }
  const trimmed = spec.trim()
  if (trimmed === '') {
    throw new Error('vp_key: key 不能为空字符串')
  }

  const parts = trimmed
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) {
    throw new Error('vp_key: key 不能为空字符串')
  }

  const modifiers = []
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier === undefined) {
      throw new Error(
        `vp_key: 不认识的修饰键 "${part}"（可用：${MODIFIER_NAMES.join(' / ')}）`,
      )
    }
    if (!Object.values(modifierEnum).includes(modifier)) {
      throw new Error(`vp_key: robot-ts 不支持修饰键 "${modifier}"`)
    }
    modifiers.push(modifier)
  }

  const rawKey = parts[parts.length - 1]
  const lowerKey = rawKey.toLowerCase()
  if (MODIFIER_ALIASES[lowerKey] !== undefined) {
    throw new Error(
      `vp_key: "${rawKey}" 只是修饰键，必须同时给一个主键（例如 ctrl+c、shift+tab）`,
    )
  }

  const canonical = KEY_ALIASES[lowerKey] ?? lowerKey
  const code = keyIndex(keyEnum).get(canonical)
  if (code === undefined) {
    throw new Error(
      `vp_key: 不认识的按键 "${rawKey}"。可用示例：enter / esc / tab / space / backspace / ` +
      'delete / up / down / left / right / f1-f12 / a-z / 0-9 / ctrl+c / shift+tab',
    )
  }

  return {
    code,
    keyName: canonical,
    modifiers,
    spec: trimmed,
  }
}

/** 该键是否是一个字符键；是则返回它对应的字符，否则返回 null。 */
export function characterForKey(keyName) {
  return CHARACTER_KEYS[String(keyName).toLowerCase()] ?? null
}

/**
 * 判断这个键是否该改走 Unicode 直注，返回要注入的字符；不该改走就返回 null。
 *
 * 规则（依据本机实测）：
 *   - 无修饰键的字符键 → 注入该字符本身
 *   - 只带 shift 的字母键 → 注入大写字母
 *   - 其余（带 ctrl/alt/meta 的组合键、控制键、space）→ null，走真实扫描码
 */
export function resolveUnicodeChar(spec) {
  const base = characterForKey(spec.keyName)
  if (base === null) return null
  if (spec.modifiers.length === 0) return base
  if (spec.modifiers.length === 1 && spec.modifiers[0] === 'Shift' && /^[a-z]$/.test(base)) {
    return base.toUpperCase()
  }
  return null
}
