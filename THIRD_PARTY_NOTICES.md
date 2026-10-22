# Third-Party Notices

本插件包含两类第三方内容：**随源码分发的派生代码**（第一节），以及**直接依赖的 npm 库**（第二节）。
第二节的文本复制自各依赖随包分发的 LICENSE 文件，与 `package-lock.json` 锁定的版本一致。

---

## 一、派生代码：`src/vp-ssh-core.js`

该文件是远程执行层的「独立维护副本」，不是原创实现。来源链：

```
dsh-web / packages / dsh-ssh/src          Apache-2.0   https://github.com/zhu1090093659/dsh-web
  └─ dolphin-ssh-core.js                  MIT          dsh-dolphin-security（裁剪为单文件 ESM）
      └─ vp-ssh-core.js  （本文件）         MIT          本项目 dsh-copilot-vision
```

- **直接上游**：`dsh-dolphin-security@0.3.1` 的 `dolphin-ssh-core.js`（MIT，Copyright (c) 2026 Dolphin Contributors）
- **最上游**：`dsh-ssh`（Apache License 2.0，Copyright (c) dsh-web contributors）
- **完整原文**：`THIRD_PARTY_LICENSES/dsh-web-Apache-2.0.txt`、`THIRD_PARTY_LICENSES/dsh-dolphin-security-MIT.txt`
- **同源实现**：`dsh-remote-rea` 的 `remote-ssh-core.js` 与本文件同出一源（该项目做过 DOLPHIN→REVERSE 的机械改名，本文件未做）

### 上游已完成、本项目继承的裁剪

以下适配由 `dsh-dolphin-security` 完成，本项目原样继承：

- 移除 `cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`、`schemastery` 等宿主专属上下文
- 移除面向 Web 界面的 `client/` 半区（含 dsh-market 遥测心跳）、`engine/pty.ts`、`engine/tunnel.ts`、`routes.ts`、`loopback.ts`
- 保留上游模块：`engine.ts`、`engine/connection-pool.ts`、`engine/sftp.ts`、`engine/cluster.ts`、`store.ts`、`protocol.ts`（类型契约以 JSDoc 保留）
- 运行时唯一三方依赖为 `ssh2`（MIT）

### 本项目对 `dolphin-ssh-core.js` 的修改（Apache-2.0 §4(b) 注明修改）

| # | 修改内容 | 位置 |
|---|---|---|
| 1 | 文件更名为 `src/vp-ssh-core.js`，并入 `src/` 目录；文件头重写，新增「为何是副本而不是 import」说明（上游 exports 只暴露 `.`，子路径 import 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`；跨目录 file-URL 导入会让 `createRequire` 上溯到源目录解析 `ssh2` 而失败） | 文件头 |
| 2 | 第 2 节标题中性化：`dsh-home.ts —— DSH_HOME 解析（移除 @deepseek-ai/dsh-settings 依赖后内联）` → `home 解析 —— DSH_HOME 解析（内联实现，不依赖宿主包）` | `resolveDolphinHome()` 上方注释 |
| 3 | **主机库路径独立化**：`storePath()` 不再调用 `resolveDolphinHome()`，改用本插件自己的文件 `$DSH_HOME/vision-pilot-ssh-hosts.json` 或 `~/.vision-pilot/ssh-hosts.json`，不与 Dolphin 共用同一主机库 | `storePath()` |
| 4 | **新增 §4.1 提权护栏**：移植 `assertNoPrivilegeEscalation()`（拦截 `sudo` 与 `--break-system-packages`）。原属上层巡逻逻辑，SSH 核心本身不含此函数；本副本只是把判定函数移入，**不自动挂进 `execCommand`**，是否对所有远程命令强制前置校验由上层调用方决定 | 原第 4 节与第 5 节之间 |
| 5 | 自检横幅与自检临时文件名改为本插件中性命名 | `selfTest()` 及文件末尾自检区 |
| 6 | **未改名保留**：`DOLPHIN_HOME`、`DOLPHIN_SSH2_MODULE`、`~/.dolphin`（`resolveDolphinHome()` 回退路径）、`resolveDolphinHome` 导出名及其余中性标识符（`isSsh2Available`、`loadSsh2`、`expandHome`、`HostStore`、`buildConnectConfig`、`execCommand`、`SshEngine` 等），以保证与上游 API 兼容 | 全文 |

> 本项目自身代码以 MIT 发布（见 `LICENSE`）；上述派生文件在再分发时，其 Apache-2.0 部分仍受 Apache License 2.0 约束，不做 MIT 化处理。本项目未使用上游商标，未以原作者名义背书。

---

## 二、直接依赖的 npm 库

| 依赖 | 锁定版本 | 许可证 |
|---|---|---|
| robot-ts | 2.0.3 | MIT |
| ssh2 | 1.17.0 | MIT |
| pixelmatch | 8.0.0 | ISC |
| pngjs | 7.0.0 | MIT |

### robot-ts (MIT)

```
The MIT License

Copyright (c) 2019 Code Quality Resources

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### ssh2 (MIT)

```
Copyright Brian White. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

### pixelmatch (ISC)

```
ISC License

Copyright (c) 2025, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### pngjs (MIT)

```
pngjs original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
