# Vision-Pilot

为 DSH（DeepSeek Harness）打造的 Computer Use 增强插件：让模型不仅能「看」屏幕，还能「等」变化、并「精准」操作。纯 JS 生态实现——无 sharp、无 OpenCV、无重型 native 图像库，唯一的 native 依赖是 robot-ts 随包分发的 Windows 预编译模块。

## 核心设计

### 双轨执行

本地轨道经 robot-ts 直连 Windows（屏幕捕获 + 鼠标注入 + 键盘注入 + 低层键盘钩子）；`src/vp-ssh-core.js` 预留远程轨道接口。当前发版只启用本地轨道，远程不注册任何工具——接口在那里，能力按需放开。

### 动态视觉感知：不传全屏，传差分

`vp_screenshot_diff` 用 pixelmatch 逐像素比对，4 邻域连通块合并，小于 100 像素的噪声（光标、闪烁）直接丢弃，把「哪里变了」而不是「整屏是什么」交还给模型。`vp_wait_change` 更进一步：每 100ms 在内存里截屏比对，**轮询期零落盘**，变化出现的瞬间才落一张正式截图。「等页面加载」从反复截图碰运气，变成一次有明确语义的等待。换显示器或改缩放后坐标即不可信——宽高或 scaleFactor 不一致直接报错，绝不重采样硬算。网格放大图不再固定 4 倍：按区域面积自适应倍率——≤50,000 物理像素 4x、≤200,000 2x、更大 1x 只画网格，大区域不再产出巨图；同时以「放大后单边 ≤2,000 像素」兜底，4,344×4 这类细长条不会被放大成 17,376 宽的畸形长图。每个区域以 `gridScale` 字段标明实际倍数。`coverage` 只是变色像素的比例，白底同类元素位移时可能仅 2% 却已改天换地——判断变化要看 `regions` 与 `gridPath` 的实际内容，不能只看覆盖率。上下文策略同样内置在工具 description 里（「长程上下文纪律」）：旧图会被清理、历史路径随时可能失效，模型必须以最新一次观察为准，偏离预期就直接重新截图，不翻历史记录。

### 人机共驾安全：持续授权 + 物理热键急停

V1.3 起授权只有三态：`unauthorized` / `pending-persistent` / `persistent`。铁律：**授权只由人的动作进入和撤销，不由时钟改变**——没有到期时间，没有剩余毫秒，持续授权等再久都不失效（回归测试用 35 秒等待证明这一点）。

- **进入授权**：按 Shift+Space 直接进入持续授权；或模型调 `vp_request_auth(mode='persistent')`，你在问答卡片上确认一次。
- **急停**：任何时候再按一次 Shift+Space，立即回到 `unauthorized`。这是物理热键，不经过模型、不依赖宿主 UI。
- **未授权即拦截**：`vp_click` / `vp_click_relative` / `vp_type` / `vp_key` 在未授权时直接抛错并提示人类开启持续授权，不会自己弹卡片。
- **审计**：JSON Lines 记录每次授权迁移，以及每次注入的放行/拒绝（`actionAllowed` / `actionDenied`），只记动作与工具名，不记任何按键内容。

为什么取消单次授权：V1.2.2 实测发现，点卡片上的「允许」会把焦点抢回 DSH 窗口，紧接着的注入就落进错误窗口。V1.3 让键盘与鼠标共用持续授权，注入前不再有任何焦点跳转。

<!-- 配图位 1：授权问答卡片截图（宿主内 vp_request_auth 弹出的人类确认卡片） -->

### 位置编码注入

大模型在原尺寸小图上数错行、估偏上百像素是常态。Vision-Pilot 把坐标计算交还给代码：每个差分区域附一张 `gridPath` 放大图——按区域面积与单边长度自适应倍率（4x / 2x / 1x，放大后单边 ≤2,000 像素）的最近邻放大，每 20 物理像素一条半透明红线，网格原点就是区域左上角（pngjs + 手写 Bresenham，零新增依赖）。模型只负责数格子、报百分比，`vp_click_relative` 完成精确换算。实测：模型按网格估点落进文字区，误差 ≤ 2.5px；同一场景靠肉眼估坐标偏过 111px。

<!-- 配图位 2：vp-grid-*.png 网格放大图示例（自适应倍率 4x/2x/1x 且单边 ≤2,000 像素，红线每格 = 20 物理像素） -->

## 工具集

| 工具 | 一句话 |
|---|---|
| `vp_screenshot` | 截主屏全屏，返回 `shotId`——后续一切操作的句柄。 |
| `vp_screenshot_diff` | 与历史截图逐像素差分，输出差异区域 + 网格放大图。 |
| `vp_wait_change` | 高频轮询等待屏幕变化，变化即返回；超时不消耗 shotId。 |
| `vp_click` | 按绝对物理坐标点击（内部换算逻辑坐标，需持续授权）。 |
| `vp_click_relative` | 在差分区域的网格图内按相对百分比点击（需持续授权）。 |
| `vp_type` | 在当前焦点输入一段文本（Unicode 直注，中英文通吃；**绝不自动回车**；需持续授权）。 |
| `vp_key` | 发送一次按键或组合键（enter / tab / esc / ctrl+c）；**回车只能由它触发**；需持续授权。 |
| `vp_request_auth` | 请求人类开启持续授权（仅 `mode='persistent'`），经宿主问答卡片等待确认。 |
| `vp_auth_status` | 只读查询授权状态、热键可用性与审计日志路径。 |
| `vp_summarize` | **收工必调**：归档关键截图、写入总结，清空其余全部临时碎片。 |

## 语义级记忆压缩（vp_summarize）

临时图会跨会话堆积。`vp_summarize` 让模型在**一个任务周期结束、准备收工或切换任务时**主动做一次收尾：

1. `keepShotIds` 里的关键截图（例如「初始页」和「结果页」）被移进 `archives/` 子目录，索引路径同步更新——归档后仍然可以做差分回看；
2. `summary` 连同本次保留清单追加写入 `archive-summary.txt`；
3. 当前目录下其余所有 `vp-shot-*`、`vp-diff-*`、`vp-grid-*` 立即删除，返回各类碎片数量。

**保护区**：`audit.log`（证据链）、`shot-index.json`（shotId 播种与相对点击依赖）、`archives/`（冷存储，一次归档永久保留）永远不会被删除。被清理掉的 shotId 在索引里保留条目，避免 `nextShotId` 回退导致旧 shotId 静默指向新截图；此时对它们做差分/等待会得到「文件已被 vp_summarize 清理，请重新截图」的明确错误。

与 `paths.js` 里的 `cleanupVisualFragments`（启动时删 3 天前的 diff/grid）**不冲突**：那个是按时间的兜底，只碰 diff/grid；本工具是按语义的主清理，目标集合是它的超集。

## 键盘注入：与鼠标共用持续授权

键盘能力分两个工具：`vp_type` 负责输入文本，`vp_key` 负责发送按键与组合键。V1.3 起键盘不再有独立的逐次确认通道，规则只有三条：

1. **键盘与鼠标共用 `checkCanClick()`**——`persistent` 下两者一律直接放行，`unauthorized` 下一律直接拦截。注入前不再弹卡片，因此不会出现「点允许 → 焦点跳回 DSH → 注入落错窗口」。
2. **`vp_type` 绝不自动发送 Enter**——回车只能由 `vp_key` 单独触发，且必须在 `vp_key` 的 `thought` 里说明意图。
3. **每个动作工具都要写旁白**——`vp_click` / `vp_click_relative` / `vp_type` / `vp_key` 都带必填的 `thought` 参数，用一句自然语言说明当前动作，原样回显在返回 JSON 里，作为给人看的进度旁白。

### 输入法（IME）实测结论

robot-ts 有两条注入通道，本插件按键的性质分流：

| 通道 | 底层 | 适用 |
|---|---|---|
| Unicode 直注 | `KEYEVENTF_UNICODE` | 文本字符，绕开键盘布局与输入法 |
| 真实扫描码 | `KEYEVENTF_SCANCODE` | 控制键与组合键，保留真实按键语义 |

本机中文输入法（WeType）实测会**吞掉扫描码注入的字母键**：按下不落字，要到下一次 Enter 才吐出幽灵字符；还会把引号改写成中文弯引号。因此 `vp_key` 对「无修饰键的字符键（字母/数字/符号）」改走 Unicode 直注——`vp_key "a"` 会立刻落下 `a`，不会留下幽灵文本。控制键（enter / esc / tab / 方向键 / backspace / delete / f1-f12）、空格、以及任何带 ctrl / alt / meta 的组合键走真实扫描码：实测 Ctrl 修饰键确实送达（Ctrl+V 能粘上内容），Shift+End 能选出整段。返回值里的 `method` 字段会告诉你这次走的是哪条通道。

注意：如果用户正在用输入法打字，组合串还挂在输入法里，此时 `vp_key enter` 会把它一起提交出去。

## 长程任务工作流（The OSA V Loop）

这段协议内嵌在全部 10 个工具的 description 里，模型每次调用都会被提醒：

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
DSH_HOME=<DSH_HOME> dsh plugin --profile web add file:<绝对路径>/dsh-copilot-vision-1.3.1.tgz
```

- **宿主**：web（问答卡片授权）/ headless（无 UI 答者，只能 Shift+Space，需真人在场）/ desktop（待 DSH 市场审核后内置验证）。
- **授权**：按 Shift+Space 开启或撤销持续授权；模型也可调 `vp_request_auth(mode='persistent')` 请求，你在卡片上确认一次。单次授权已取消。
- **平台**：仅 Windows、仅本地主屏。pnpm 11 拦截构建脚本时，在 profile 的 `pnpm-workspace.yaml` 中允许 `robot-ts` 构建；native 缺失时插件仍可加载，调用时返回可读错误。
- **落盘**：截图、索引、审计日志默认在 `os.tmpdir()/vision-pilot-shots/`，`VP_SHOT_DIR` 可整体重定向。
- **迭代**：tarball 是快照，同版本重新 `add` 会被判 "Already up to date"——改源码后标准流程是 `npm pack` → `remove` → `add`。

## 限制与边界

- **输入能力边界**：支持键盘输入（`vp_type` 文本 / `vp_key` 按键与组合键）；不支持拖拽、滚轮、双击。键盘只作用于**当前焦点控件**，模型无法自己「在地址栏输入」前必须先用鼠标点中输入框。
- **输入法干扰**：中文输入法会吞掉扫描码注入的字母键（按下不落字，要到下一次 Enter 才吐幽灵字符）。插件已对无修饰键的字符键改走 Unicode 直注绕开它，但用户在输入法里挂着的组合串仍会被 `vp_key enter` 一起提交。
- **聊天窗口自干扰**：宿主聊天窗口的流式重绘会被当成屏幕变化（实测覆盖率约为变化门限的 14 倍）。等页面加载时，先把聊天窗口移出主屏或最小化。
- **鼠标移动不可检测**：Windows 屏幕捕获不含硬件光标，挪鼠标不产生任何像素变化。
- **热键无法区分真人与合成按键**：按键事件流不携带注入标记，审计日志只作事后追溯、不作防伪。真正的护栏在插件之外——宿主安全分类器与操作纪律。
- **索引并发**：截图索引整份覆盖写、不做跨进程并发保护，多进程共用 `VP_SHOT_DIR` 会互相覆盖；回归测试一律用独立目录。
- **临时目录卫生**：超过 3 天的差分/网格切片（`vp-diff-*` / `vp-grid-*`）会在插件启动时被自动清理；模型在收工时调用 `vp_summarize` 会把关键截图归档到 `archives/` 并清空其余全部碎片。基准截图（`vp-shot-*`）、审计日志、索引与 `archives/` 永久保留。

## 本地验证

> 以下脚本为开发期本机验证用，含本机绝对路径，**不随仓库与 npm 包分发**（`.gitignore` 已排除 `test-*.mjs`）。克隆仓库后需自备对应脚本。

```bash
node test-mvp.mjs        # 三态授权 + 热键急停/接管 + 无时钟衰减（约 45s，真实点击屏幕中心）
node test-diff.mjs       # 差分与索引（单元层不碰屏幕；--integration 需配合动屏）
node test-relative.mjs   # 网格渲染 + 相对坐标换算 + 未授权闸门（不截图、不注入）
node test-wait.mjs       # 轮询语义（--integration 配合静屏/动屏/假基线）
node test-keyboard.mjs   # 键名解析 + 注入通道分流 + 持续授权闸门（--live 会真的抢一次键盘焦点）
node test-summarize.mjs  # 记忆压缩：5 张截图保留 2 张，校验清理、保护区与幂等（不碰屏幕）
```

---

License: MIT（见 LICENSE 与 package.json）。第三方依赖声明见 THIRD_PARTY_NOTICES.md。
