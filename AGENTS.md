# AGENTS.md

Bookmark Radar — Chrome 扩展（Manifest V3），扫描浏览器书签、提取小说/漫画最新章节、检测死链与重复书签、生成分类报告。

开源地址：<https://github.com/firzen/bookmark-radar>

## 技术栈与运行方式

- 纯原生 JavaScript (ES6+)，**无构建工具、无 Node.js、无任何依赖**
- 不要引入打包器、转译器或 npm 包；所有代码直接在源文件中编辑
- 加载方式：`chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序
- 调试：Service Worker 在扩展卡片点链接打开 DevTools；Popup 右键图标 → 检查

## 验证改动的注意事项（重要）

- **MV3 不会热更新**：修改任何源文件后，必须在 `chrome://extensions/` 手动重载扩展，否则 Service Worker 仍运行旧代码，排查「结果与预期不符」时先确认是否已重载
- 无自动化测试框架，验证靠手动触发扫描；描述改动时应给出明确的手动验证步骤

## 目录结构与模块职责

```
manifest.json              # MV3 配置，权限: bookmarks/storage/tabGroups/scripting/webNavigation
background/
  service-worker.js        # 入口：importScripts 按序加载 + 消息路由 + 全局配置
  checker.js               # 单书签检查管道：静态抓取 → 导航 → 注入 → 验证重试 → 兜底决策
  scan-runner.js           # 并发调度：worker 标签、进度、缓存写入（全量扫描与重扫共用）
  report-store.js          # 报告组装与存储：摘要、修剪、合并、部分报告
content/
  extractor.js             # 页面内容提取与目录判定（注入与 SW 双入口，勿写成依赖 DOM 的单入口）
shared/
  classifier.js            # 分类唯一事实源：验证页/错误页特征、net 错误映射、缓存规则
  renderer.js / i18n.js    # 报告渲染 / 国际化
popup/  report/  icons/    # 弹窗界面 / 全宽报告页 / 图标
_locales/en|zh_CN/         # chrome.i18n 文案
promo/                     # 商店宣传截图素材（与功能代码无关）
```

**加载顺序**：service-worker.js 经 `importScripts` 按序加载：i18n → classifier → extractor → report-store → checker → scan-runner。新增共享模块时注意插入顺序（被依赖者在前）。

## 核心架构约定

- **分类逻辑只写在 `shared/classifier.js`**：验证页/错误页特征、网络错误映射、缓存规则的唯一事实源，不要在 checker/report 里散落重复判断
- **双缓存分离**：
  - `resultCache`：非目录页结果，30 天 TTL，参与扫描跳过与中断兜底（扫描中断后用缓存恢复已有进度）
  - `directoryCache`：已提取章节的目录结果，**仅用于中断兜底，不参与正常扫描的跳过逻辑**（目录页每次重查以追踪更新）
  - 超时、验证页结果不缓存；强制扫描清缓存时避免清空导致状态丢失
- **抓取策略**：书签检查必须走「真实标签页加载 + 脚本注入」，不能纯用 fetch/ajax——会漏判 JS 渲染页面；fetch 仅用于 Service Worker 中的轻量回退诊断
- **统一选择模型**：报告页「重扫」与「删除」共用同一套勾选框，不要拆成两套选择状态

## 国际化

- 所有用户可见文案走 `chrome.i18n.getMessage()`，同时更新 `_locales/en/messages.json` 和 `_locales/zh_CN/messages.json`，缺一个语言会在另一语言下显示为空
- README 双语维护：`README.md`（中文）/ `README.en.md`（英文），更新功能描述时两份都要改

## Git 规范

- 提交信息使用 `fix:` / `refactor:` 等前缀，正文包含**根因分析和解决方案**（Chromium 类问题尤其要写清原生行为机制）
- 推送到 `origin main`

## 已知 Chromium / MV3 陷阱

- **Shift+点击 checkbox** 的原生区间切换无法被 `preventDefault()` 阻止，需用 `setTimeout` 回写状态来接管
- **后台标签页 rAF 被暂停**，Cloudflare JS 质询无法在后台标签自动通过，需临时前台激活标签
- **HTTPS-First 模式**会把 http 书签升级失败，处理 http 链接需考虑降级/重试策略
- **无 `tabs` 权限时无法读取错误页 URL**，错误页识别依赖 `webNavigation` 事件
- 标签组（tabGroups）在所有标签关闭后会被 Chrome 自动删除，不要依赖标签组持久存在
- 部分 CDN 会按 Service Worker 默认 UA 拦截请求，SW 内发请求注意 UA 处理

## 工作流程

- **先方案后代码**：新增功能或改动现有逻辑前，先给出完整技术方案（原理、数据模型、改动点、注意事项），确认后再写代码
