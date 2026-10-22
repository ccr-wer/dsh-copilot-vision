# Vision-Pilot

为 DSH（DeepSeek Harness）打造的 Computer Use 增强插件：让模型不仅能「看」屏幕，还能「等」变化、并「精准」操作。纯 JS 生态实现——无 sharp、无 OpenCV、无重型 native 图像库，唯一的 native 依赖是 robot-ts 随包分发的 Windows 预编译模块。

## 核心设计

### 双轨执行

本地轨道经 robot-ts 直连 Windows（屏幕捕获 + 鼠标注入 + 低层键盘钩子）；`src/vp-ssh-core.js` 预留远程轨道接口。当前发版只启用本地轨道，远程不注册任何工具——接口在那里，能力按需放开。

### 动态视觉感知：不传全屏，传差分

`vp_screenshot_diff` 用 pixelmatch 逐像素比对，4 邻域连通块合并，小于 100 像素的噪声（光标、闪烁）直接丢弃，把「哪里变了」而不是「整屏是什么」交还给模型。`vp_wait_change` 更进一步：每 100ms 在内存里截屏比对，**轮询期零落盘**，变化出现的瞬间才落一张正式截图。「等页面加载」从反复截图碰运气，变成一次有明确语义的等待。换显示器或改缩放后坐标即不可信——宽高或 scaleFactor 不一致直接报错，绝不重采样硬算。

### 人机共驾安全

授权是一个五态状态机（unauthorized / pending-once / authorized-once / pending-persistent / persistent），铁律：**授权只由人的动作进入和撤销，不由时钟改变**——没有到期时间，没有剩余毫秒，持续授权等再久都不失效（回归测试用 35 秒等待证明这一点）。人有三条通道：问答卡片上点「允许」、Shift+Space 热键随时接管或撤销、JSON Lines 审计日志事后追溯（只记状态机动作与来源，不记任何按键内容）。点击闸门顺序是授权 → 参数 → 越界 → 消费，失败路径不浪费单次授权。

<!-- 配图位 1：授权问答卡片截图（宿主内 vp_request_auth 弹出的人类确认卡片） -->

### 位置编码注入

大模型在原尺寸小图上数错行、估偏上百像素是常态。Vision-Pilot 把坐标计算交还给代码：每个差分区域附一张 `gridPath` 放大图——4x 最近邻放大，每 20 物理像素一条半透明红线，网格原点就是区域左上角（pngjs + 手写 Bresenham，零新增依赖）。模型只负责数格子、报百分比，`vp_click_relative` 完成精确换算。实测：模型按网格估点落进文字区，误差 ≤ 2.5px；同一场景靠肉眼估坐标偏过 111px。

<!-- 配图位 2：vp-grid-*.png 网格放大图示例（4x，红线每格 = 20 物理像素） -->

## 工具集

| 工具 | 一句话 |
|---|---|
| `vp_screenshot` | 截主屏全屏，返回 `shotId`——后续一切操作的句柄。 |
| `vp_screenshot_diff` | 与历史截图逐像素差分，输出差异区域 + 网格放大图。 |
| `vp_wait_change` | 高频轮询等待屏幕变化，变化即返回；超时不消耗 shotId。 |
| `vp_click` | 按绝对物理坐标点击（内部换算逻辑坐标，需已授权）。 |
| `vp_click_relative` | 在差分区域的网格图内按相对百分比点击（需已授权）。 |
| `vp_request_auth` | 请求人类授权（once / persistent），经宿主问答卡片等待确认。 |
| `vp_auth_status` | 只读查询授权状态、热键可用性与审计日志路径。 |

## 长程任务工作流（The OSA V Loop）

这段协议内嵌在全部 7 个工具的 description 里，模型每次调用都会被提醒：

1. **观察 Observe**——每步开始前，用截图或差分确认当前屏幕状态。
2. **行动 Act**——点击目标（绝对坐标或相对百分比）。
3. **等待 Wait**——点击后必须立刻 `vp_wait_change`。绝对禁止连续两次点击（盲点）：第二次点击必须以界面反馈为前提。
4. **验证 Verify**——结合变化区域与超时判断是否达标；`timeout:true` 意味着可能失败或卡死，必须重新截图观察、重新规划，绝不盲目重试。

模型的工作日志就是它自己每一次工具调用的原始 JSON 返回——纠错靠重读上一步的返回，不靠想象。

<!-- 配图位 3：OSA V Loop 循环示意图（观察→行动→等待→验证） -->

## 快速开始

```bash
# 从 npm 安装
DSH_HOME=<DSH_HOME> dsh plugin --profile web add dsh-copilot-vision

# 或从本地 tarball 安装（开发调试）
npm pack
DSH_HOME=<DSH_HOME> dsh plugin --profile web add file:<绝对路径>/dsh-copilot-vision-1.0.0.tgz
```

- **宿主**：web（问答卡片授权）/ headless（无 UI 答者，只能 Shift+Space，需真人在场）/ desktop（待 DSH 市场审核后内置验证）。
- **授权**：模型调 `vp_request_auth`，你在卡片上确认；或随时 Shift+Space 进入持续授权、再按撤销。
- **平台**：仅 Windows、仅本地主屏。pnpm 11 拦截构建脚本时，在 profile 的 `pnpm-workspace.yaml` 中允许 `robot-ts` 构建；native 缺失时插件仍可加载，调用时返回可读错误。
- **落盘**：截图、索引、审计日志默认在 `os.tmpdir()/vision-pilot-shots/`，`VP_SHOT_DIR` 可整体重定向。
- **迭代**：tarball 是快照，同版本重新 `add` 会被判 "Already up to date"——改源码后标准流程是 `npm pack` → `remove` → `add`。

## 限制与边界

- **输入能力边界**：不支持键盘注入、拖拽、滚轮、双击。模型无法自己「在地址栏输入」，该步需人代做。
- **聊天窗口自干扰**：宿主聊天窗口的流式重绘会被当成屏幕变化（实测覆盖率约为变化门限的 14 倍）。等页面加载时，先把聊天窗口移出主屏或最小化。
- **鼠标移动不可检测**：Windows 屏幕捕获不含硬件光标，挪鼠标不产生任何像素变化。
- **热键无法区分真人与合成按键**：按键事件流不携带注入标记，审计日志只作事后追溯、不作防伪。真正的护栏在插件之外——宿主安全分类器与操作纪律。
- **索引并发**：截图索引整份覆盖写、不做跨进程并发保护，多进程共用 `VP_SHOT_DIR` 会互相覆盖；回归测试一律用独立目录。
- **临时目录卫生**：超过 3 天的差分/网格切片（`vp-diff-*` / `vp-grid-*`）会在插件启动时被自动清理，基准截图（`vp-shot-*`）和审计日志永久保留。

## 本地验证

> 以下脚本为开发期本机验证用，含本机绝对路径，**不随仓库与 npm 包分发**（`.gitignore` 已排除 `test-*.mjs`）。克隆仓库后需自备对应脚本。

```bash
node test-mvp.mjs        # 五态授权 + 热键/卡片竞态 + 无时钟衰减（约 45s，真实点击屏幕中心）
node test-diff.mjs       # 差分与索引（单元层不碰屏幕；--integration 需配合动屏）
node test-relative.mjs   # 网格渲染 + 相对坐标换算 + 未授权闸门（不截图、不注入）
node test-wait.mjs       # 轮询语义（--integration 配合静屏/动屏/假基线）
```

---

License: MIT（见 LICENSE 与 package.json）。第三方依赖声明见 THIRD_PARTY_NOTICES.md。
