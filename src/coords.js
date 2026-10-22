// 坐标契约的唯一真相源。
//
// robot-ts 的两套坐标系是不对称的：
//   - screen.capture* / screen.pixel 吃 physical（物理像素，含 DPI 缩放）
//   - mouse.move / mouse.position   吃 logical（逻辑像素 = physical / scaleFactor）
//
// vp_screenshot 产出的图像尺寸是物理像素，模型看图给出的坐标因此也是物理像素；
// vp_click 在注入前必须经 physicalToLogical() 换算，否则 125% 缩放下会偏 25%。
// 回归依据：test-click.mjs 实测 scaleFactor = 1.25，physical = 1920x1200，logical = 1536x960。

/** 物理像素 → 逻辑像素。p 为 {x, y}，scaleFactor 来自 primaryMonitor().scaleFactor。 */
export function physicalToLogical(point, scaleFactor) {
  return { x: point.x / scaleFactor, y: point.y / scaleFactor }
}

/**
 * 局部区域内的相对位置 → 全局物理坐标。
 * xPercent/yPercent ∈ [0, 1]：0 = bbox 左/上边缘，1 = bbox 右/下边缘（含）。
 * 用 width-1 / height-1 是为了「1.0 落在最后一个像素上」，而不是落到 bbox 外面一像素。
 * 这是 vp_click_relative 的唯一换算公式，测试直接对它断言。
 */
export function relativeToPhysical(bbox, xPercent, yPercent) {
  for (const [label, value] of [['xPercent', xPercent], ['yPercent', yPercent]]) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} 必须是有限数字，收到 ${value}`)
    }
    if (value < 0 || value > 1) {
      throw new Error(`${label} 必须在 0 到 1 之间（含端点），收到 ${value}`)
    }
  }
  if (
    bbox === null || typeof bbox !== 'object' ||
    !Number.isInteger(bbox.x) || !Number.isInteger(bbox.y) ||
    !Number.isInteger(bbox.width) || !Number.isInteger(bbox.height) ||
    bbox.width < 1 || bbox.height < 1
  ) {
    throw new Error(`bbox 必须是整数且宽高 >=1，收到 ${JSON.stringify(bbox)}`)
  }
  return {
    x: bbox.x + Math.round(xPercent * (bbox.width - 1)),
    y: bbox.y + Math.round(yPercent * (bbox.height - 1)),
  }
}
