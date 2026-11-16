# DSH Sidebar Browser

面向 DeepSeek Harness Desktop 的原生侧栏浏览器。Agent 调用 `browser_navigate` 后，当前会话右侧出现 **Agent Browser**。Agent 的快照、点击、填表和截图都来自该 Electron 网页，用户可直接在页面上接手。依赖已安装的 DSH Desktop 0.2.1-rc.5。

## 安装

通过 DSH Desktop 的插件管理器添加 GitHub 源 `github:thestuckedcat/dsh-sidebar-browser-playwrite`，或使用桌面 profile 的命令行。若 DSH 提示 Git 源的构建需要批准，可按提示批准该包的构建脚本。

```sh
dsh plugin --profile desktop add github:thestuckedcat/dsh-sidebar-browser-playwrite
```

也可以从源码构建 tarball，再通过桌面 profile 安装该归档。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
dsh plugin --profile desktop add ./dsh-sidebar-browser-playwrite-0.2.0.tgz
```

已有其他插件占用 `browser_*` 工具名时，可通过 `sidebar-browser-tools` 行的 `toolPrefix` 改名。卸载时在同一 profile 移除 `dsh-sidebar-browser-playwrite`。

## 使用

在 DSH Desktop 打开会话，再要求 Agent 打开 HTTP(S) 网页。导航工具返回快照和元素引用，Agent 可调用 `browser_click`、`browser_fill`、`browser_press` 等操作。切换会话后，工具只接收发起它的会话请求。关闭 Agent Browser 标签会释放其 guest，随后可用 `browser_navigate` 重新打开。

- `browser_open_tab`、`browser_tabs`、`browser_switch_tab` 和 `browser_close_tab` 管理 Agent Browser 内的网页。
- 截图支持当前视口和可见元素，完整滚动页截图与 `networkidle` 等待会返回不支持。Electron 导航等待完整页面加载。
- 密码和文件输入由用户在网页中操作。结构化提取不读取表单值。
- `browser_evaluate` 默认关闭，`browser_extract` 需要配置提取模型。提取会发送选定网页数据给所配置的模型。
- `sidebar-browser-provider` 行的 `allowedDomains` 可限制工具导航和操作的目标域名。Electron 的网页网络策略仍由 DSH 主进程负责。

## 开发与验证

```sh
pnpm test
pnpm build
node scripts/smoke-desktop.cjs "E:/dsh/DeepSeek Harness.exe"
```

桌面测试使用独立 DSH profile、已安装的 Electron 外壳和本机合成页。实现细节和已验证范围见 [机制说明](docs/mechanisms.md)。

基于 [ChenyuHeee/dsh-browser-playwright](https://github.com/ChenyuHeee/dsh-browser-playwright) 的 MIT 许可工具接口和快照实现。版权声明见 [LICENSE](LICENSE)。
