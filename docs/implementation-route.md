# DSH 原生侧栏适配实现路线

> **For agentic workers:** Steps use checkbox syntax. Review the completed diff against the stated product and the shipped package.

## 目标

Agent 通过 `browser_*` 打开并操作当前 DSH Desktop 会话中可见的同一网页。

**基线和来源**

| 来源 | 采用方式 |
| --- | --- |
| [ChenyuHeee/dsh-browser-playwright@57ebe45fb906](https://github.com/ChenyuHeee/dsh-browser-playwright/tree/57ebe45fb906b6977312a0c7562d407faee4b449) | 直接复用 MIT 许可的工具定义、Provider 合同、snapshot 和文本渲染。用原生侧栏后端替换独立浏览器后端。 |
| 本机 DSH Desktop `0.2.1-rc.5` build `d4db512`，Electron `44.7.0` | 通过 client module 与右栏 slot 薄适配，调用原生 guest 租约。对照内置实现的 partition、bootstrap URL、dom-ready 和释放顺序。 |
| 本工作区 rc.5 Host → Client 验证及 `08-workbench-ui/src/http-rpc.mjs` | 借鉴已验证的本机 Host 路由、owner admission 和 Client RPC envelope。自行实现只传固定动作的会话桥接。 |

**实施顺序**

- [x] `tests/native-bridge.test.ts` 先固定会话匹配、命令只领取一次、结果关联和超时取消，再实现 `src/sidebar-bridge.ts`。
- [x] `src/sidebar.ts` 注册原生 Provider 与认证路由，沿用 `BrowserSession` 方法。 `src/sidebar-client.ts` 负责激活会话、右栏标签、guest 生命周期和命令派发。 `src/guest.ts` 只对该标签拥有的 Electron guest 执行动作。
- [x] 更新包入口、构建脚本、依赖及 CI。首个端到端验收在原装 rc.5 隔离配置装载打包产物，用真实工具运行时打开合成页，点击改动可见内容，填表后从同一个 guest 观察效果。
- [x] 运行回归与独立评审，保存隔离运行证据，完成机制说明。

发布位置为用户指定的 [thestuckedcat/dsh-sidebar-browser-playwrite](https://github.com/thestuckedcat/dsh-sidebar-browser-playwrite)。

## 边界

Host 将请求绑定工具调用的会话。Client 仅领取当前可见会话的命令，并在派发前复核。Electron 主进程批准 guest、固定沙箱和浏览隔离。公开路由使用 DSH 的 owner admission。可选域名约束适用于工具导航及操作检查，网页子资源仍由 DSH 和系统处理。关闭、超时、网页加载失败均提供可核对的结果。
