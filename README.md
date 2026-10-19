# dsh-zotero-flow

DeepSeek Harness（DSH Desktop）插件：**连接 Zotero，在机构登录下把文献全文取回来，并连同条目一起归入指定分类。**

它给 agent 装上的是一条完整流水线：

```
DOI/标题  →  规范元数据  →  机构登录会话里取 PDF  →  归档进 Zotero 分类
```

> 仓库：<https://github.com/YHzed/dsh-zotero-flow> · MIT

---

## 它能做什么

| 工具 | 作用 |
| --- | --- |
| `zotero_status` | 体检：Zotero 是否在跑、连接器 / 本地 API 状态、当前归档目标、浏览器会话与落盘目录 |
| `library_sites` | 列出院内「数据资源数据库」里的各站点（知网、万方、ScienceDirect、WoS、Springer、IEEE、Wiley、T&F、ACS、SciFinder、IOP、MathSciNet、ProQuest、SpiScholar、科学文库、超星…）以及每站取全文的可行路径 |
| `literature_lookup` | 用 DOI / 标题 / arXiv 号解析规范元数据（Crossref、OpenAlex、Unpaywall，**免密钥**），并给出开放获取 PDF 直链与出版社归属 |
| `scholar_session` | 起一个**独立资料目录**的 Edge/Chrome，用户在其中登录学校 SSO / CARSI / WebVPN；之后打开页面并读回引文 DOI、`citation_pdf_url`、页面 PDF 链接、登录/付费/验证码迹象 |
| `scholar_download` | 在已登录会话里抓 PDF 落盘。三条通道自动竞速：下载落盘 / Network 响应体 / 页面内 fetch；也能只监视下载目录，接管用户手动点的「下载全文」 |
| `zotero_collections` | 查看当前归档目标与可选分类 |
| `zotero_save` | 元数据 + PDF 一次性归档到分类（DOI/标题 + 本地或在线 PDF + 标签 + 子笔记） |
| `zotero_import_pdf` | 把本地已有 PDF 归档；先从 PDF 里抠 DOI 解析元数据，抠不到就交给 Zotero 自己识别 |

外加一份技能（`zotero-literature-flow`）和一段系统提示，教模型按正确顺序用这些工具、以及什么时候该停下来问用户。

---

## 安装

插件是一个标准的 DSH 组合包（`package.json` 里声明了 `dsh.bundle.patch`）。

**从 GitHub 取下来**

```bash
git clone https://github.com/YHzed/dsh-zotero-flow.git
```

**从界面安装**

1. 打开 DSH Desktop 的 **侧栏 → 插件**。
2. 点 **添加插件**。
3. 在输入框里填插件目录的**绝对路径**（或打包好的 `.tgz` 绝对路径），例如 clone 下来的
   `D:\tools\dsh-zotero-flow`
4. 点 **安装**，装完点 **立即启用**。

如果插件装在了别处或你想自己打包一个 `.tgz`：在插件目录下跑 `npm pack`（无依赖，直接可用），
把生成的 `dsh-zotero-flow-1.0.0.tgz` 路径填进「添加插件」即可。

**装完确认**：回到对话里让 agent 调一次 `zotero_status`，能看到 Zotero 版本和落盘目录就通了。

> 改了插件代码之后要重新走一遍安装（profile 里的插件是复制进去的，不感知源码更新）。

---

## 首次使用前的两件事

### 1. Zotero 桌面端要开着

插件走的是 **Zotero 自带的连接器 HTTP 服务**（`127.0.0.1:23119`），默认就是开的，不需要 API key。
`zotero_status` 会打印版本号，读到版本号即通。

**建议再打开本地 API**（可选，但能明显提升体验）：
Zotero → **编辑 → 设置 → 高级 → 常规** → 勾选「**允许本机其他应用与 Zotero 通信**」。

- 关着：只能看到「当前选中的分类」与「最近使用过的分类」，库内条目检索不可用。
- 打开：能读到带 key 的完整分类树，并能在库内检索、查重。

> 注意：Zotero 的**本地 API 是只读的**（所有端点只支持 GET），写入一律走连接器服务。所以「新建分类」这类操作需要本地 API，而「保存条目 / 挂 PDF」不需要。

### 2. 先登录一次机构账号

第一次需要取全文时，agent 会调 `scholar_session action=start`，弹出一个**独立的浏览器窗口**
（资料目录默认 `%USERPROFILE%\.dsh-zotero-flow\edge-profile`，和你日常用的浏览器互不干扰）。

在这个窗口里完成学校登录（图书馆统一身份认证 / CARSI / WebVPN），**登录状态会长期保留**，之后每次取全文都复用它。

如果你的学校需要走 WebVPN 或 EZproxy 前缀，把前缀填进插件配置的 `institutionProxy`，例如：

```yaml
institutionProxy: https://webvpn.example.edu.cn/http/
```

---

## 典型用法

对 agent 说：

> 帮我下 10.1038/nature12373 这篇，存到 Zotero 的「纳米测温」分类

agent 会：`zotero_status` 体检 → `literature_lookup` 拿元数据 → `scholar_session` 打开 DOI 落地页 →
`scholar_download` 抓 PDF → `zotero_save` 归档。

中文库这类只能人工点击的：

> 从知网找「高熵合金 金属陶瓷」那篇，下载后存进 Zotero

agent 会打开知网检索页并**把下载这一步交给你**：你在弹出的窗口里点「下载全文」，
然后 agent 用 `scholar_download`（不传 url）接管下载目录里新出现的 PDF，再 `zotero_import_pdf` 归档。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆写（用户层补丁会在插件层之后生效）：

```yaml
- id: dsh-zotero-flow
  name: 'dsh-zotero-flow'
  config:
    zoteroPort: 23119        # Zotero 本地 HTTP 服务端口
    mailto: you@example.edu  # Crossref / Unpaywall 的「礼貌池」邮箱，建议填
    browserPath: ''          # 留空自动探测 Edge / Chrome
    browserProfileDir: ''    # 机构登录用的资料目录
    cdpPort: 9333            # 浏览器调试端口
    downloadDir: ''          # PDF 落盘目录
    institutionProxy: ''     # WebVPN / EZproxy 前缀
    proxyUrl: ''             # 插件自身 HTTP 抓取的出口代理（不影响浏览器）
```

站点清单在 `lib/catalog.js` 的 `LIBRARY_SITES`：里面是各校图书馆资源页上通用的主流库，
要补自己机构独有的入口（校内门户、专业库），照该数组里现有对象的形状往末尾加一条即可
（`pdf` 取 `'direct' | 'meta-pdf' | 'manual' | 'mixed'`，JS 渲染的站点标 `stableSearch: false`）。

---

## 已知边界（重要，别踩）

**① Zotero 连接器只能归档到「当前选中的分类」或「最近使用过的分类」。**
这是 Zotero 自身的设计（`SaveSession.update` 通过 `zp.collectionsView.selectByID()` 切换目标）。
所以要让文献进某个分类，正确做法是**先在 Zotero 左侧点选那个分类**，再让 agent 归档。
`zotero_collections action=targets` 会列出当前可选的目标 id（`L1` / `C12` 这类）。
**本地 API 里的分类 key 不是连接器的目标 id**，两者不能混用。

> 副作用提醒：归档时插件会调 `updateSession` 把目标分类落到条目上，**Zotero 界面里选中的分类会跟着切过去**。
> 这是 Zotero 连接器协议本身的行为，不是插件在乱动你的界面。

**② 全文权限来自用户的机构会话，不来自插件的 HTTP 请求。**
从 Node 进程直接 fetch 出版社页面通常只会拿到付费墙或登录页。要全文就必须走浏览器会话。

**③ 附件必须带一个非空的来源 URL。**
Zotero 的 `Zotero.Attachments.importFromNetworkStream` 在 `url` 为空 / 缺失 / `null` 时直接抛异常，
服务端只回一个光秃秃的 500（`SAVE_ATTACHMENT` 失败时看不到原因）。
插件已经处理：抓取来源 → DOI 落地页 → 兜底值，依次取第一个非空。

**④ 中文库基本没有可自动下载的 PDF 直链。**
知网、万方、ProQuest 学位论文、科学文库、读秀都是 JS 应用，PDF 往往分章节或走专门阅读器。
插件不硬碰，改为「打开页面 → 用户点击 → 接管下载目录」。

**⑤ 浏览器会被设成「PDF 一律下载」。**
这是必需的：Chromium 默认用内建阅读器**显示** PDF，此时响应体既不进网络栈也落不了盘，
CDP 根本拿不到字节。插件在自己的资料目录里把 `plugins.always_open_pdf_externally` 设为 true，
PDF 直接进 `downloadDir` —— 既拿到字节，用户也顺手得到文件。这个设置只影响插件自己的资料目录。

**⑥ 无法把 PDF 挂到「库里已有的旧条目」上。**
连接器的 `saveAttachment` 只能挂到同一次会话（`saveItems` 之后）里创建的条目，且本地 API 是只读的。
所以流程是「建条目 + 挂 PDF 一次做完」；对已有 PDF 用 `zotero_import_pdf`（会重新建条目）。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `Zotero 未响应` | Zotero 桌面端没开，或端口被改过（同步改 `zoteroPort`） |
| `本地 API 未开启` | 正常状态，只是分类树与库内检索受限；需要就按上文勾选 |
| `Zotero 挂载 PDF 失败（HTTP 500）` | 见「已知边界 ③」，通常是来源 URL 为空 |
| 浏览器起不来 | 未装 Edge/Chrome，或 `cdpPort` 被占用；用 `browserPath` 显式指定 |
| 抓不到 PDF | 页面需要登录 / 有人机校验 / 无订阅权限；`scholar_session` 的返回里会带「页面迹象」 |
| 归档到了错的分类 | `zotero_collections action=targets` 看可选目标，在 Zotero 里点选正确分类后重试 |

自检脚本（在插件目录下，也可以 `npm test` / `npm run selftest:browser` / `npm run selftest:zotero`）：

```bash
node scripts/test-tools.mjs          # 只读：加载插件、跑不写库的工具
node scripts/selftest-browser.mjs    # 浏览器会话 + CDP PDF 抓取（本地起服务，不依赖外网）
node scripts/test-zotero-write.mjs   # 写库：会往 Zotero 里存一条带自检标记的测试条目
node scripts/session.mjs status      # 手动驱动机构登录会话（同 lib/browser.js）
```

`test-zotero-write.mjs` 会真的写入你的库，标题里带「插件自检请删除」、标签 `dsh-zotero-flow-selftest`，跑完请自行删除。

---

## 结构

```
index.js                 插件入口：注册工具 / 技能 / 系统提示
lib/define-tool.js       本地 defineTool（schema DSL → JSON Schema），不依赖宿主包
lib/catalog.js           数据资源站点目录、DOI 前缀 → 出版社映射
lib/zotero.js            Zotero 客户端（连接器 API + 只读本地 API）
lib/metadata.js          Crossref / OpenAlex / Unpaywall / PDF 内 DOI 抽取
lib/browser.js           Edge CDP 会话、页面分析、三通道 PDF 抓取
lib/tools.js             8 个工具的定义与实现、归档主流程
client/client.js         浏览器端 Toolview（含数据库网格卡片）
skills/literature-flow/  技能正文
```

## 许可

MIT
