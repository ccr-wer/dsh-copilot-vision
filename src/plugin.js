// Vision-Pilot 的工具定义（宿主无关的工厂）。
// createPlugin(defineTool, ctx, hotkeyState) 接收宿主的 defineTool 与 ctx，
// 因此本地可以用 mock 验证注册结构，index.js 则传入真实宿主对象。
// 本文件不直接 import 宿主包。

import { screenshotAction, clickAction, clickRelativeAction, typeAction, keyAction, normalizeThought } from './actions.js'
import { diffAction } from './diff.js'
import { waitChangeAction } from './wait.js'
import { summarizeAction } from './summarize.js'
import { getStatus, requestAuth, confirmPending, cancelPending } from './auth.js'
import { auditLogPath } from './audit.js'
import { consumeNotice } from './shot-index.js'

export const name = 'dsh-copilot-vision'
export const inject = ['tools', 'userQuestions']

// 长程任务工作流（OSA V Loop）：统一追加在所有工具 description 末尾的行为约束。
// 必须先于各 description 常量定义（const 无提升，顺序错了模块初始化直接 ReferenceError）。
const AGENT_PROTOCOL =
  '长程任务工作流建议（必须遵守）：' +
  '1. 观察（Observe）：每步开始前，用截图或差分确认当前屏幕状态。' +
  '2. 行动（Act）：点击目标（绝对坐标或相对坐标）。' +
  '3. 等待（Wait）：点击后必须立刻调用 vp_wait_change，确认界面给出了反馈。' +
  '4. 验证（Verify）：结合 wait_change 的返回结果（变化区域、超时），判断是否达到了本步目标；' +
  '注意 coverage 低不代表界面没变——相同底色的元素位移或扩展可能覆盖率极低但布局已巨变，' +
  '判断要以 regions 与 gridPath 的实际内容为准；' +
  '若超时未变，重新截图全局（Observe）再规划。' +
  '你的“工作日志”就是你自己每一次工具调用的原始 JSON 返回，请在每次决策前仔细阅读上一步的返回。'

// 盲点禁令：连续两次点击之间没有等待 = 第二次点在旧界面上。
const BLIND_CLICK_WARNING =
  '绝对禁止连续两次点击（盲点）。每次点击后，必须立刻调用 vp_wait_change 等待界面响应。'

// 长程上下文纪律：只追加在三个「视觉产出」工具（screenshot/diff/wait）的 description 末尾，
// 防止模型反复翻历史截图路径把上下文越滚越长。
const CONTEXT_DISCIPLINE =
  '【长程上下文纪律】' +
  '1. 你的物理工作目录中，历史的差分图和网格图会被定期自动清理。' +
  '请永远只依赖最近一次调用返回的 shotId 和 path。' +
  '2. 不要去回忆或引用十分钟前的截图路径，如果当前状态偏离预期，请直接重新截图（vp_screenshot），' +
  '不要试图在历史记录里找答案。' +
  '3. 历史步骤的文本结论可以留在你的记忆里，但旧图像文件随时可能失效，以最新观察为准。'

// coverage 误导：白底同类元素位移/扩展时，覆盖率可能只有百分之几，但布局已经巨变。
const COVERAGE_WARNING =
  '【重要：关于 coverage】coverage 只是变色像素的面积比例。' +
  '如果界面是相同背景色（如白底）的元素位移或扩展，coverage 会非常低，但界面布局可能已经发生巨变。' +
  '判断界面是否发生重要改变，不要只看 coverage，要以返回的 regions 和 gridPath 的实际内容为准。'

// 多尺度感知策略：流式输出/闪烁干扰下收缩注意力到 region，失配时回退全局重新定位。
const MULTI_SCALE_STRATEGY =
  '【多尺度感知策略】' +
  '局部优先：如果屏幕有流式输出或闪烁干扰，请优先传入 region 参数，只盯住你关心的局部区域。' +
  '失配回退：如果你在 region 内等待超时，说明目标可能发生偏移，此时绝对不要盲目重试，' +
  '必须立刻调用 vp_screenshot 重新获取全屏视图，重新全局定位目标。'

// 旁白要求：模型必须用一句自然语言说明自己在干什么，这句话会展示给用户。
const THOUGHT_REQUIRED =
  '【必须写旁白】调用本工具时必须通过 thought 参数，用一句自然语言描述你当前正在做什么' +
  '（例如「我点击了搜索框，准备输入文字」）。这句话会作为进度旁白展示给用户，' +
  '也是人判断「这个工具到底在干什么」的唯一依据，不许省略、不许写「执行操作」这类空话。'

const SCREENSHOT_DESCRIPTION =
  '截取主屏全屏并保存为 PNG 文件，返回文件路径（不是 base64，避免占用 token）。' +
  '返回的图像尺寸为物理像素，坐标原点为主屏左上角。' +
  'MVP 阶段仅支持主屏全屏：不支持区域截图，不支持多显示器选择。' +
  '每次调用都会生成新文件（文件名带时间戳），默认落盘到 os.tmpdir()/vision-pilot-shots/（可用 VP_SHOT_DIR 覆盖）。' +
  '返回值中的 scaleFactor 用于把图像坐标换算成鼠标注入所需的逻辑坐标；' +
  '调用 vp_click 时直接传图像上的物理像素坐标即可，换算由 vp_click 内部完成。' +
  '返回的 shotId 可用于 vp_screenshot_diff 的 baseline 参数。' +
  AGENT_PROTOCOL +
  CONTEXT_DISCIPLINE +
  MULTI_SCALE_STRATEGY

const DIFF_DESCRIPTION =
  '把当前屏幕与一张历史截图做逐像素差分，返回连通差异区域及其局部裁剪图。' +
  'baseline 是 vp_screenshot 返回的 shotId（数字，不是文件路径）；工具会自己截一张当前图再比对，不需要传第二张。' +
  'threshold 是像素色差阈值（0~1，越小越敏感，默认 0.1）。' +
  'regions[].bbox 与 regions[].offset 都是物理像素，原点为截图左上角，与 vp_click 的坐标系一致：' +
  '如果在局部图 localPath 上看到目标位于 (lx, ly)，要点击它就传全局坐标 (bbox.x + lx, bbox.y + ly)。' +
  'localPath 是原尺寸裁剪，局部图 1 像素等于全局 1 像素。' +
  '每个区域还附带 gridPath：该区域的最近邻放大网格图，放大倍数按区域面积自适应' +
  '（≤50000 物理像素 4 倍、≤200000 2 倍、更大 1 倍），且放大后任何单边不超过 2000 像素' +
  '（长边 >500 不做 4 倍、>1000 不做 2 倍），实际倍数见 regions[].gridScale；' +
  '红色网格横向/纵向每一格 = 20 物理像素，网格原点就是 bbox 左上角；' +
  '配合 vp_click_relative 可直接按相对百分比点击，不必自己算全局坐标。' +
  '找目标时，优先使用此工具生成局部放大网格图（gridPath）。不要在全屏图上瞎猜坐标，尽量使用 vp_click_relative 汇报百分比。' +
  '排在第 12 个之后的区域不生成 gridPath，该区域带 gridSkipped 说明原因（bbox 与 localPath 仍可用）。' +
  '小于 100 像素的差异块按噪声（光标、闪烁）丢弃。' +
  'coverage 是差异像素占整屏像素的比例（0~1）；coverage 大于 0.4 时局部图已经没有意义，建议直接看全屏截图。' +
  COVERAGE_WARNING +
  'changed=false 表示没有超过噪声阈值的差异区域，不等于屏幕完全没变；要确认刚才的操作是否生效，建议看全屏。' +
  'baseline 与当前截图的宽高或 scaleFactor 不一致时直接报错（多半是换了显示器或改了缩放比例），' +
  '不做重采样硬算，请重新调用 vp_screenshot 取新的 baseline。' +
  '可选 region：只比对以 (x,y) 为左上角的 width×height 局部区域（物理像素整数，原点主屏左上角），' +
  '区域外的任何变化（如聊天区的流式输出、光标闪烁）都会被彻底忽略，适合在有背景干扰时只盯目标区域；' +
  '此时返回的 regions bbox/offset 仍然加回了 region 偏移、是全屏绝对坐标（与 vp_click 一致，可直接换算），' +
  'coverage 变为差异像素占 region 面积的比例；region 越界或含非整数直接报错。' +
  '每次调用都会真实截一张新屏幕并写入索引，返回的 currentShotId 可以继续当 baseline 用。' +
  AGENT_PROTOCOL +
  CONTEXT_DISCIPLINE +
  MULTI_SCALE_STRATEGY

const WAIT_DESCRIPTION =
  '等待屏幕相对某张历史截图发生变化：工具内部循环截屏并逐像素比对，一旦变化面积超过阈值就立刻返回，' +
  '省得你因为「页面还没加载完」而反复调 vp_screenshot_diff 碰运气。' +
  'baseline 是 vp_screenshot 返回的 shotId（数字，不是路径）；timeoutMs 是最长等待毫秒（默认 3000，上限 30000）；' +
  'threshold 是像素色差阈值（0~1，默认 0.1），语义与 vp_screenshot_diff 相同。' +
  '抽帧频率采用动态降频（呼吸阀）：初始每 100ms 一帧，连续 1 秒没有变化放宽到 200ms，' +
  '超过 2 秒没变化放宽到 500ms，降低底层截屏句柄的申请频率；这套降频只作用于「还没检测到变化」的等待阶段。' +
  '静默期（Quiet-period）：检测到变化后不会立刻返回——第一帧变化往往只是渲染中途（文字逐字出现、骨架屏先出后填）。' +
  '工具会再按每 100ms 观察一次，连续 3 次（约 300ms）没有新的实质变化，才认为界面渲染稳定并返回最终的变化区域；' +
  '静默期内如果又出现新变化，计时自动重置；静默期最多观察 2 秒，画面持续在变也会强行返回当前结果（settled=false），避免拖死等待。' +
  '实测 1920x1200 单帧 81~242ms（截屏 45~54ms + 比对 5~30ms + 连通块 12~15ms；' +
  '屏上有大片差异时连通块更贵，屏越安静越快），帧耗时超过当前间隔时不等间隔直接接下一帧。' +
  '轮询期间完全不落盘、不写截图索引，只在内存里比对；只有检测到变化并退出循环时才生成一张正式截图（落盘+写索引）。' +
  '因此超时未变不会消耗 shotId，也不会往截图目录堆文件。' +
  '变化判据：过滤噪声（抗锯齿像素、以及小于 100 像素的连通块）后，差异像素占被比对区域比例 > 0.001 才算变了。' +
  '可选 region：只观察以 (x,y) 为左上角的 width×height 局部区域（物理像素整数），' +
  '区域外的任何变化（如聊天区的流式输出）都会被彻底忽略，不会误触发返回；' +
  '返回的 regions bbox/offset 仍是全屏绝对坐标，coverage 为差异像素占 region 面积的比例。' +
  '检测到变化返回 {changed:true, waitedMs, quietMs, settled, currentShotId, regions, coverage}，' +
  '其中 waitedMs 是从开始等到返回的总时长（含静默期），quietMs 是静默期实际等待时长，' +
  'settled=true 表示静默期内观测到连续稳定，false 表示 2 秒上限触顶、画面仍在变化；' +
  'currentShotId 是那张正式截图，可以继续当后续 baseline 用。' +
  COVERAGE_WARNING +
  '超时未变返回 {changed:false, waitedMs, timeout:true}，没有 currentShotId 也没有 regions；' +
  '说明这段时间屏幕真的没动。如果返回 timeout: true，代表操作可能失败或界面卡死：' +
  '绝对不要盲目重试，必须先调用 vp_screenshot 获取全局截图、重新规划，再决定下一步（包括是否继续等待）。' +
  '坐标系与 vp_screenshot_diff 完全一致：regions[].bbox 与 offset 都是物理像素、原点为截图左上角，' +
  '局部图 localPath 未放大；在局部图上看到目标位于 (lx, ly)，要点它就传全局坐标 (bbox.x + lx, bbox.y + ly)。' +
  '每个区域还附带 gridPath：按面积自适应放大的网格图（≤50000 物理像素 4 倍、≤200000 2 倍、更大 1 倍；' +
  '放大后任何单边不超过 2000 像素，长边 >500 不做 4 倍、>1000 不做 2 倍，实际倍数见 regions[].gridScale），' +
  '每一格 = 20 物理像素，原点为 bbox 左上角；配合 vp_click_relative 可直接按相对百分比点击。' +
  '排在第 12 个之后的区域没有 gridPath，会带 gridSkipped 说明。' +
  '它只负责「等」，不会替你制造变化：需要交互就先 vp_click，再用本工具等界面响应。' +
  AGENT_PROTOCOL +
  CONTEXT_DISCIPLINE +
  MULTI_SCALE_STRATEGY

const CLICK_DESCRIPTION =
  '在主屏上点击一次鼠标。入参 x/y 为物理像素坐标，原点为主屏左上角，' +
  '与 vp_screenshot 返回图像的坐标系一致。' +
  '内部会除以主屏 scaleFactor 换算成逻辑坐标再注入鼠标，调用方不要自己换算。' +
  '坐标越界会直接抛错，不会静默夹到边界。' +
  '调用前必须处于持续授权（persistent）：由用户按 Shift+Space 开启，' +
  "或调用 vp_request_auth(mode='persistent') 请求人类确认。未授权时会直接抛错，不会弹卡片。" +
  'MVP 阶段仅支持单击：不支持拖拽、滚轮、双击；键盘输入请用 vp_type / vp_key。' +
  THOUGHT_REQUIRED +
  BLIND_CLICK_WARNING +
  AGENT_PROTOCOL

const CLICK_RELATIVE_DESCRIPTION =
  '在某个差分区域内部按相对位置点击，不需要自己计算全局像素坐标。' +
  'shotId 用 vp_screenshot_diff / vp_wait_change 返回的 currentShotId；index 是 regions 数组里的 1-based 序号。' +
  'xPercent/yPercent 是 0.0~1.0 的相对位置：0 表示区域左/上边缘，1 表示右/下边缘。' +
  '建议先看该区域的 gridPath：那是按面积自适应放大的网格图（倍数见 regions[].gridScale），横向/纵向每一小格 = 20 物理像素，' +
  '网格原点为 bbox 左上角；数好格子后，用「格数 × 20 ÷ bbox 宽（或高）」换算成百分比，也可以直接目测。' +
  '换算由本工具完成：physical.x = bbox.x + round(xPercent × (bbox.width - 1))，y 同理；不要自己算。' +
  'index 越界、百分比不在 0~1、shotId 没有差分区域时直接抛错。' +
  '只有 vp_screenshot_diff / vp_wait_change 产生的区域可点；普通 vp_screenshot 的 shotId 没有区域。' +
  '调用前同样必须处于持续授权：由用户按 Shift+Space 开启，' +
  "或调用 vp_request_auth(mode='persistent') 请求。未授权时直接抛错，不会弹卡片。" +
  THOUGHT_REQUIRED +
  BLIND_CLICK_WARNING +
  AGENT_PROTOCOL

const TYPE_DESCRIPTION =
  '在当前有光标的焦点框内输入一段文本（输入框、搜索框、编辑区等）。' +
  '底层直接注入 Unicode 码点，与键盘布局无关，中英文、符号、emoji 都能原样打出来。' +
  '【绝对不含回车】：本工具只负责把文字打进去，绝不自动发送 Enter。' +
  '需要提交时另调 vp_key（key=enter），并且在它的 thought 里说明你要提交。' +
  '【必须先点中输入框】：调用前请确保已经用鼠标点击激活了正确的输入位置，' +
  '否则文字会打到当前焦点所在的任何控件里。' +
  '【授权与鼠标一致】：只要处于持续授权（persistent）就直接注入，不再弹卡片、不再抢焦点；' +
  "未授权时直接抛错，请提示用户按 Shift+Space，或调用 vp_request_auth(mode='persistent')。" +
  '【急停细粒度】：文本按每 40 个字符（按 Unicode 码点，中文/emoji 不会被拆开）分块注入，' +
  '每块之前都复核一次授权；用户按 Shift+Space 撤销后，最多再落下已经开始的那一块，剩余文本不再继续注入。' +
  THOUGHT_REQUIRED +
  AGENT_PROTOCOL

const KEY_DESCRIPTION =
  '发送一次按键或组合键（例如 enter、tab、esc、space、f5、ctrl+c、shift+tab）。' +
  '键名不区分大小写，支持 ctrl / shift / alt / meta 四种修饰键，用加号连接：ctrl+c。' +
  '用途是发送控制键：回车提交、Esc 退出、Tab 切换焦点。' +
  '【高危，请谨慎使用】：Enter 会提交/发送，Ctrl 组合键会复制、粘贴、全选、关闭窗口等，' +
  '发之前必须先想清楚后果，不要为了「试试看」去按。' +
  '【必须先点中目标】：本工具只把按键发给当前焦点控件，焦点不对就作用在错的窗口上。' +
  '【授权与鼠标一致】：只要处于持续授权（persistent）就直接注入，不再弹卡片、不再抢焦点；' +
  "未授权时直接抛错，请提示用户按 Shift+Space，或调用 vp_request_auth(mode='persistent')。" +
  '【回车只能由本工具触发】：vp_type 绝不会自动回车；按回车前必须在 thought 里说清意图。' +
  '【注入通道分两种，返回的 method 会告诉你走的哪条】：' +
  '不带修饰键的字符键（字母/数字/符号）走 Unicode 直注——因为系统输入法会吞掉扫描码字母键' +
  '（中文输入法下实测按下不落字，要到下一次 Enter 才吐出幽灵字符），Unicode 直注绕开输入法；' +
  '控制键（enter/esc/tab/方向键/backspace/delete/f1-f12）、空格、以及任何带 ctrl/alt/meta 的组合键' +
  '走真实扫描码，组合键语义是真的。' +
  '【输入法提示】：如果用户正在用输入法打字，组合串还挂在输入法里，本工具按 Enter 会把它一起提交出去。' +
  THOUGHT_REQUIRED +
  AGENT_PROTOCOL

const AUTH_REQUEST_DESCRIPTION =
  '请求人类开启持续授权（persistent）。这是请求，不是授权本身：' +
  '工具会暂停，并通过宿主的人类问答界面等待用户选择“允许”或“拒绝”。' +
  '确认后放行此后所有鼠标与键盘操作，直到用户按 Shift+Space 急停撤销。' +
  'V1.3 起只支持持续授权，没有单次授权——单次卡片会抢走焦点，反而破坏后续注入。' +
  '用户拒绝、取消或问答超时不会改变授权状态。' +
  '等待期间用户按了 Shift+Space 会取代这次请求：那时本工具正常返回 confirmed:false 并带 reason 说明' +
  '（热键接管/热键撤销），不是报错；以返回的 state 为准，不要重试请求。' +
  AGENT_PROTOCOL

const AUTH_STATUS_DESCRIPTION =
  '查看 Vision-Pilot 的授权状态（只读，不改变任何权限）。' +
  'state 有三种：unauthorized（未授权）、pending-persistent（持续授权待人类确认）、' +
  'persistent（持续授权中，鼠标与键盘一律放行）。' +
  '持续授权一直有效，直到用户按 Shift+Space 撤销；没有到期时间，也不返回剩余毫秒。' +
  '另返回待确认请求 pendingRequest、全局热键（Shift+Space）是否可用 hotkeyAvailable / hotkeyError，' +
  '以及授权审计日志路径 auditLogPath。' +
  AGENT_PROTOCOL

const SUMMARIZE_DESCRIPTION =
  '清理本任务的视觉记忆：归档关键截图，其余临时碎片一键清空。' +
  '【收工必调】：完成一个完整任务周期、准备收工或切换任务时，必须调用本工具——' +
  '否则临时图会跨会话堆积，换几次会话就留一堆垃圾。' +
  'keepShotIds 填你要长期保留的关键截图 shotId（例如「初始页」和「结果页」），' +
  '这些全屏截图会被移动进 archives 子目录，索引也会同步到新路径，之后仍可做差分；' +
  '其余所有 vp-shot-* 全屏截图、vp-diff-* 差分切片、vp-grid-* 网格图会被立即彻底删除。' +
  'summary 是一段文字总结，会和本次保留清单一起追加写入 archive-summary.txt。' +
  '审计日志 audit.log、截图索引 shot-index.json、archives 目录永远不被删除。' +
  '【删除不可撤销】：调用前请确认 keepShotIds 已包含所有还需要回看的截图。' +
  AGENT_PROTOCOL

const AUTH_STATES = ['unauthorized', 'pending-persistent', 'persistent']

/**
 * 弹持续授权卡片并等人类回答。V1.3 只有这一种授权卡片；
 * 键盘与鼠标共用持续授权，不再各自弹卡。
 *
 * 卡片和热键是两个都能改 pendingRequest 的人，谁先落地谁说话：热键一按，
 * signal 就 abort，这里把它变成一次 reject，和 ask() 赛跑，而不是让答案撞进
 * confirmPending() 变成「没有待确认的授权请求」。
 */
async function askAuthCard(ctx, exec, { question, allowDescription, rejectDescription }) {
  const request = requestAuth('persistent')
  const cancelled = new Promise((_resolve, reject) => {
    const abort = () => reject(request.signal.reason)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
  })
  // ask() 还没建立就可能同步抛错（宿主没有 userQuestions），那时没人接住这个 reject。
  cancelled.catch(() => {})
  let answer
  try {
    if (ctx?.userQuestions === undefined) {
      throw new Error('宿主未提供 userQuestions 服务')
    }
    const asking = ctx.userQuestions.ask({
      questions: [{
        id: 'vp-auth',
        header: 'Vision-Pilot 持续授权',
        question,
        options: [
          { label: '允许', description: allowDescription },
          { label: '拒绝', description: rejectDescription ?? '不改变授权状态' },
        ],
      }],
      ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    })
    // 本工具返回后那张卡片还在人面前，被关掉时宿主可能 reject；不能让悬空 rejection 冒出去。
    asking.catch(() => {})
    answer = await Promise.race([asking, cancelled])
  } catch (error) {
    if (error?.code === 'AUTH_CANCELLED') {
      // 不算失败：请求被更明确的人的动作取代了，把终态如实报回去。
      return {
        requestId: request.requestId,
        state: getStatus().state,
        confirmed: false,
        reason: typeof error.reason === 'string' ? error.reason : '本次请求已被取消',
      }
    }
    cancelPending()
    throw new Error(
      `授权确认失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const selected = answer?.answers?.[0]?.selected ?? []
  if (!selected.includes('允许')) {
    cancelPending()
    return {
      requestId: request.requestId,
      state: getStatus().state,
      confirmed: false,
    }
  }

  const status = confirmPending(request.requestId)
  return {
    requestId: request.requestId,
    state: status.state,
    confirmed: status.confirmed,
    ...(status.confirmed
      ? {}
      : { reason: '答案到达时这次请求已被热键接管或已取消，按丢弃处理' }),
  }
}

/** 索引损坏等只说一次的告知；render 每个结果调用一次，所以用户会看到但它不会刷屏。 */
function noticeLine() {
  const notice = consumeNotice()
  return notice === undefined ? '' : `\n注意：${notice}`
}

const BBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
  },
}

const OFFSET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
  },
}

export function createPlugin(defineTool, ctx, hotkeyState = { available: false, error: '热键尚未初始化' }) {
  const screenshotTool = defineTool({
    name: 'vp_screenshot',
    description: SCREENSHOT_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shotId: { type: 'number', required: true },
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          scaleFactor: { type: 'number', required: true },
          physicalBounds: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `截图完成：${value.path}\n` +
          `shotId：${value.shotId}（可作为 vp_screenshot_diff 的 baseline）\n` +
          `图像尺寸：${value.width}x${value.height}（物理像素，原点为主屏左上角）\n` +
          `主屏 physicalBounds：${value.physicalBounds.width}x${value.physicalBounds.height}\n` +
          `scaleFactor：${value.scaleFactor}\n` +
          JSON.stringify(value) +
          noticeLine(),
      }],
    },
    async execute() {
      return await screenshotAction()
    },
  })

  const clickTool = defineTool({
    name: 'vp_click',
    description: CLICK_DESCRIPTION,
    parameters: {
      x: {
        type: 'number',
        required: true,
        description: '物理像素 x 坐标，原点为主屏左上角，取值 0 <= x < 主屏物理宽度',
      },
      y: {
        type: 'number',
        required: true,
        description: '物理像素 y 坐标，原点为主屏左上角，取值 0 <= y < 主屏物理高度',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        default: 'left',
        description: '鼠标按键，默认 left',
      },
      thought: {
        type: 'string',
        required: true,
        description: '一句话说明你现在要做什么（例如「我点击了地址栏，准备输入搜索词」），会作为进度旁白展示给用户',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thought: { type: 'string', required: true },
          clicked: { type: 'boolean', required: true },
          physical: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          logical: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          button: { type: 'string', enum: ['left', 'right', 'middle'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `旁白：${value.thought}\n` +
          `点击完成：物理 (${value.physical.x}, ${value.physical.y}) → ` +
          `逻辑 (${value.logical.x}, ${value.logical.y})，按键 ${value.button}\n` +
          JSON.stringify(value),
      }],
    },
    async execute(args) {
      return await clickAction(args)
    },
  })

  const clickRelativeTool = defineTool({
    name: 'vp_click_relative',
    description: CLICK_RELATIVE_DESCRIPTION,
    parameters: {
      shotId: {
        type: 'number',
        required: true,
        description: 'vp_screenshot_diff / vp_wait_change 返回的 currentShotId（数字），该截图必须带差分区域',
      },
      index: {
        type: 'number',
        required: true,
        description: '差分区域序号，1-based，对应返回的 regions[0] 为 1',
      },
      xPercent: {
        type: 'number',
        required: true,
        description: '横向相对位置 0.0~1.0：0 = bbox 左边缘，1 = bbox 右边缘',
      },
      yPercent: {
        type: 'number',
        required: true,
        description: '纵向相对位置 0.0~1.0：0 = bbox 上边缘，1 = bbox 下边缘',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        default: 'left',
        description: '鼠标按键，默认 left',
      },
      thought: {
        type: 'string',
        required: true,
        description: '一句话说明你现在要做什么（例如「我点击了搜索结果里的第二条」），会作为进度旁白展示给用户',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thought: { type: 'string', required: true },
          clicked: { type: 'boolean', required: true },
          shotId: { type: 'number', required: true },
          index: { type: 'number', required: true },
          bbox: BBOX_SCHEMA,
          relative: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              xPercent: { type: 'number', required: true },
              yPercent: { type: 'number', required: true },
            },
          },
          physical: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          logical: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
          },
          button: { type: 'string', enum: ['left', 'right', 'middle'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `旁白：${value.thought}\n` +
          `相对点击完成：shot #${value.shotId} region #${value.index}，` +
          `相对 (${value.relative.xPercent}, ${value.relative.yPercent}) → ` +
          `物理 (${value.physical.x}, ${value.physical.y}) → ` +
          `逻辑 (${value.logical.x}, ${value.logical.y})，按键 ${value.button}\n` +
          `bbox=(${value.bbox.x}, ${value.bbox.y}) ${value.bbox.width}x${value.bbox.height}\n` +
          JSON.stringify(value),
      }],
    },
    async execute(args) {
      return await clickRelativeAction(args)
    },
  })

  const typeTool = defineTool({
    name: 'vp_type',
    description: TYPE_DESCRIPTION,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要输入的文本（支持中英文/符号/emoji）。本工具绝不自动发送回车。',
      },
      thought: {
        type: 'string',
        required: true,
        description: '一句话说明你现在要做什么（例如「我在搜索框里输入 DeepSeek」），会作为进度旁白展示给用户',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thought: { type: 'string', required: true },
          typed: { type: 'string', required: true },
          success: { type: 'boolean', required: true },
          method: { type: 'string', enum: ['unicode'], required: true },
          chars: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `旁白：${value.thought}\n` +
          `输入完成：${value.typed}（${value.chars} 字符，Unicode 直注，未发送回车）\n` +
          JSON.stringify(value),
      }],
    },
    async execute(args) {
      const thought = normalizeThought(args.thought, '（模型未提供旁白）')
      // 授权与注入都在 typeAction 内完成：persistent 直接打字，unauthorized 直接抛错。
      // V1.3 起这里不再弹卡片——点「允许」会把焦点抢回 DSH，紧接着的注入就落错窗口了。
      const result = await typeAction({ text: args.text, thought })
      return {
        thought,
        typed: result.typed,
        success: true,
        method: result.method,
        chars: result.chars,
      }
    },
  })

  const keyTool = defineTool({
    name: 'vp_key',
    description: KEY_DESCRIPTION,
    parameters: {
      key: {
        type: 'string',
        required: true,
        description: '键名或组合键，例如 enter / esc / tab / space / f5 / ctrl+c / shift+tab',
      },
      thought: {
        type: 'string',
        required: true,
        description: '一句话说明你现在要按这个键做什么（例如「我按回车提交搜索」），会作为进度旁白展示给用户',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thought: { type: 'string', required: true },
          key: { type: 'string', required: true },
          keyName: { type: 'string', required: true },
          modifiers: { type: 'array', required: true, items: { type: 'string' } },
          method: { type: 'string', enum: ['unicode', 'scancode'], required: true },
          success: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `旁白：${value.thought}\n` +
          `按键完成：${value.key}` +
          `${value.modifiers.length > 0 ? `（修饰键：${value.modifiers.join('+')}）` : ''}` +
          `（通道：${value.method === 'unicode' ? 'Unicode 直注' : '真实扫描码'}）\n` +
          JSON.stringify(value),
      }],
    },
    async execute(args) {
      const thought = normalizeThought(args.thought, '（模型未提供旁白）')
      // 授权与注入都在 keyAction 内完成：persistent 直接按键，unauthorized 直接抛错。
      const result = await keyAction({ key: args.key, thought })
      return {
        thought,
        key: result.key,
        keyName: result.keyName,
        modifiers: result.modifiers,
        method: result.method,
        success: true,
      }
    },
  })

  const diffTool = defineTool({
    name: 'vp_screenshot_diff',
    description: DIFF_DESCRIPTION,
    parameters: {
      baseline: {
        type: 'number',
        required: true,
        description: 'vp_screenshot 返回的历史截图 shotId（数字）',
      },
      threshold: {
        type: 'number',
        default: 0.1,
        description: '像素色差阈值，0~1，越小越敏感，默认 0.1',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description: '可选。只比对这块局部区域（物理像素整数，原点主屏左上角）：' +
          'x/y 为区域左上角（>=0），width/height 为区域宽高（>=1，不超出屏幕）。' +
          '区域外的任何变化（流式输出、闪烁）被彻底忽略；返回的 bbox/offset 仍为全屏绝对坐标。',
        properties: {
          x: { type: 'number', required: true, description: '区域左上角 x（物理像素，>=0）' },
          y: { type: 'number', required: true, description: '区域左上角 y（物理像素，>=0）' },
          width: { type: 'number', required: true, description: '区域宽度（物理像素，>=1）' },
          height: { type: 'number', required: true, description: '区域高度（物理像素，>=1）' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          regions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bbox: BBOX_SCHEMA,
                localPath: { type: 'string', required: true },
                gridPath: { type: 'string' },
                gridScale: { type: 'number' },
                gridSkipped: { type: 'string' },
                offset: OFFSET_SCHEMA,
              },
            },
          },
          coverage: { type: 'number', required: true },
          baselineShotId: { type: 'number', required: true },
          currentShotId: { type: 'number', required: true },
          coordinateContract: { type: 'string', enum: ['physical'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `差分完成：baseline #${value.baselineShotId} → current #${value.currentShotId}，` +
          `坐标系 ${value.coordinateContract}\n` +
          (value.changed
            ? `差异区域 ${value.regions.length} 处，coverage ${(value.coverage * 100).toFixed(2)}%` +
              `${value.coverage > 0.4 ? '（超过 40%，建议直接看全屏截图）' : ''}\n` +
              value.regions.map((region, i) =>
                `  #${i + 1} bbox=(${region.bbox.x}, ${region.bbox.y}) ` +
                `${region.bbox.width}x${region.bbox.height}；` +
                `全局坐标 = (bbox.x + lx, bbox.y + ly) = (${region.bbox.x} + lx, ${region.bbox.y} + ly)；` +
                `局部图 ${region.localPath}` +
                (region.gridPath !== undefined
                  ? `；网格图 ${region.gridPath}（${region.gridScale} 倍放大，每格 20 物理像素）`
                  : `；无网格图：${region.gridSkipped}`),
              ).join('\n')
            : '未发现超过噪声阈值的差异区域；要确认操作是否生效，建议看全屏截图') +
          `\n` + JSON.stringify(value) +
          noticeLine(),
      }],
    },
    async execute(args) {
      return await diffAction(args)
    },
  })

  const waitTool = defineTool({
    name: 'vp_wait_change',
    description: WAIT_DESCRIPTION,
    parameters: {
      baseline: {
        type: 'number',
        required: true,
        description: 'vp_screenshot 返回的历史截图 shotId（数字）；本工具等的是「相对这张图变了」',
      },
      timeoutMs: {
        type: 'number',
        default: 3000,
        description: '最长等待毫秒，默认 3000，上限 30000；超时返回 changed=false 且 timeout=true',
      },
      threshold: {
        type: 'number',
        default: 0.1,
        description: '像素色差阈值，0~1，越小越敏感，默认 0.1（语义同 vp_screenshot_diff）',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description: '可选。只观察这块局部区域（物理像素整数，原点主屏左上角）：' +
          'x/y 为区域左上角（>=0），width/height 为区域宽高（>=1，不超出屏幕）。' +
          '区域外的任何变化（流式输出、闪烁）被彻底忽略，不会误触发返回；' +
          '返回的 bbox/offset 仍为全屏绝对坐标。',
        properties: {
          x: { type: 'number', required: true, description: '区域左上角 x（物理像素，>=0）' },
          y: { type: 'number', required: true, description: '区域左上角 y（物理像素，>=0）' },
          width: { type: 'number', required: true, description: '区域宽度（物理像素，>=1）' },
          height: { type: 'number', required: true, description: '区域高度（物理像素，>=1）' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          waitedMs: { type: 'number', required: true },
          timeout: { type: 'boolean', required: true },
          quietMs: { type: 'number' },
          settled: { type: 'boolean' },
          currentShotId: { type: 'number' },
          baselineShotId: { type: 'number' },
          coverage: { type: 'number' },
          coordinateContract: { type: 'string', enum: ['physical'] },
          regions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bbox: BBOX_SCHEMA,
                localPath: { type: 'string', required: true },
                gridPath: { type: 'string' },
                gridScale: { type: 'number' },
                gridSkipped: { type: 'string' },
                offset: OFFSET_SCHEMA,
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `等到变化了：相对 baseline #${value.baselineShotId} 在 ${value.waitedMs}ms 后返回` +
            `（静默期 ${value.quietMs}ms，${value.settled ? '渲染已稳定' : '达到 2 秒上限、画面仍在变化'}），` +
            `已落盘为 current #${value.currentShotId}，坐标系 ${value.coordinateContract}\n` +
            `差异区域 ${value.regions.length} 处，coverage ${(value.coverage * 100).toFixed(2)}%` +
            `${value.coverage > 0.4 ? '（超过 40%，建议直接看全屏截图）' : ''}\n` +
            value.regions.map((region, i) =>
              `  #${i + 1} bbox=(${region.bbox.x}, ${region.bbox.y}) ` +
              `${region.bbox.width}x${region.bbox.height}；` +
              `全局坐标 = (${region.bbox.x} + lx, ${region.bbox.y} + ly)；` +
              `局部图 ${region.localPath}` +
              (region.gridPath !== undefined
                ? `；网格图 ${region.gridPath}（${region.gridScale} 倍放大，每格 20 物理像素）`
                : `；无网格图：${region.gridSkipped}`),
            ).join('\n') +
            `\n` + JSON.stringify(value) + noticeLine()
          : `等待 ${value.waitedMs}ms 超时：屏幕相对 baseline #${_args.baseline} 没有可见变化，` +
            `本次未落盘、未消耗 shotId。超时未检测到变化。请先调用 vp_screenshot 重新观察全屏，切勿盲目重试。\n` +
            JSON.stringify(value) + noticeLine(),
      }],
    },
    async execute(args) {
      return await waitChangeAction(args)
    },
  })

  const requestAuthTool = defineTool({
    name: 'vp_request_auth',
    description: AUTH_REQUEST_DESCRIPTION,
    parameters: {
      mode: {
        type: 'string',
        enum: ['persistent'],
        required: true,
        description: "只支持 persistent：确认后持续放行鼠标与键盘，直到用户按 Shift+Space 撤销",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', required: true },
          state: { type: 'string', enum: AUTH_STATES, required: true },
          confirmed: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `${value.confirmed ? '授权已确认' : '授权未通过'}：state=${value.state}` +
          (value.reason !== undefined ? `；原因：${value.reason}` : '') +
          `\n` + JSON.stringify(value),
      }],
    },
    async execute(args, exec) {
      const card = await askAuthCard(ctx, exec, {
        question: '是否允许 Vision-Pilot 持续执行鼠标与键盘操作，直到你按 Shift+Space 撤销？',
        allowDescription: '持续放行，直到按 Shift+Space 撤销',
        rejectDescription: '不改变授权状态',
      })
      return card
    },
  })

  const authStatusTool = defineTool({
    name: 'vp_auth_status',
    description: AUTH_STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', enum: AUTH_STATES, required: true },
          pendingRequest: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requestId: { type: 'string', required: true },
              mode: { type: 'string', enum: ['persistent'], required: true },
              requestedAt: { type: 'number', required: true },
            },
          },
          hotkeyAvailable: { type: 'boolean', required: true },
          hotkeyError: { type: 'string' },
          auditLogPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `授权状态：${value.state}；热键 ${value.hotkeyAvailable ? '可用' : '不可用'}` +
          (value.hotkeyError !== undefined ? `（${value.hotkeyError}）` : '') +
          `；审计日志：${value.auditLogPath}\n` +
          JSON.stringify(value),
      }],
    },
    async execute() {
      return {
        ...getStatus(),
        hotkeyAvailable: hotkeyState.available,
        ...(hotkeyState.error !== undefined ? { hotkeyError: hotkeyState.error } : {}),
        auditLogPath: auditLogPath(),
      }
    },
  })

  const summarizeTool = defineTool({
    name: 'vp_summarize',
    description: SUMMARIZE_DESCRIPTION,
    parameters: {
      keepShotIds: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '要长期保留的关键截图 shotId 列表（例如初始页与结果页）；其余截图会被删除',
      },
      summary: {
        type: 'string',
        required: true,
        description: '本次任务的文字总结，会连同保留清单追加写入 archive-summary.txt',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          archivedShotIds: { type: 'array', required: true, items: { type: 'number' } },
          missingShotIds: { type: 'array', required: true, items: { type: 'number' } },
          failedShotIds: { type: 'array', required: true, items: { type: 'number' } },
          failedArchives: { type: 'number', required: true },
          removedShots: { type: 'number', required: true },
          removedDiff: { type: 'number', required: true },
          removedGrid: { type: 'number', required: true },
          removedTotal: { type: 'number', required: true },
          failedDeletes: { type: 'number', required: true },
          archivesDir: { type: 'string', required: true },
          summaryPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text:
          `记忆压缩完成：归档 ${value.archivedShotIds.length} 张关键截图，` +
          `清理 ${value.removedTotal} 个临时碎片` +
          `（截图 ${value.removedShots}、差分 ${value.removedDiff}、网格 ${value.removedGrid}）\n` +
          (value.failedArchives > 0
            ? `注意：shotId ${value.failedShotIds.join(',')} 归档失败（可能被占用），源文件已保留未删除\n`
            : '') +
          `总结：${value.summary}\n` +
          `归档目录：${value.archivesDir}\n` +
          JSON.stringify(value),
      }],
    },
    async execute(args) {
      return await summarizeAction(args)
    },
  })

  const tools = [
    screenshotTool,
    diffTool,
    waitTool,
    clickTool,
    clickRelativeTool,
    typeTool,
    keyTool,
    requestAuthTool,
    authStatusTool,
    summarizeTool,
  ]

  // 不再提供 apply() 方法：注册的唯一生产路径是 index.js 的 apply(ctx)（逐个 register tools），
  // 此前挂在本方法里的启动清理因无人调用而从未触发，清理已随接线修复移入 index.js。
  return {
    name,
    inject,
    tools,
  }
}
