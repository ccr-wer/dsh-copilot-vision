// robot-ts 惰性加载器（actions.js 与 hotkey.js 共用）。
// 顶层不解析 native 模块：即使 profile 未允许构建、prebuilds 未落地，
// 插件仍能被宿主加载、工具仍出现在列表里；只有真正调用时才返回可读错误。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let robotTsModule

export function loadRobotTs() {
  if (robotTsModule !== undefined) return robotTsModule
  try {
    robotTsModule = require('robot-ts')
    return robotTsModule
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`robot-ts 不可用（native 模块未安装或 profile 未允许构建）：${detail}`)
  }
}
