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

**自动导入前必须打开本地 API**（用于强制检索与查重）：
Zotero → **编辑 → 设置 → 高级 → 常规** → 勾选「**允许本机其他应用与 Zotero 通信**」。

- 关着：只能看到「当前选中的分类」与「最近使用过的分类」，库内条目检索不可用。
- 打开：能读到带 key 的完整分类树，并能在库内检索、查重。

> Zotero 10+ 的本地 API 支持经过用户授权的写入和附件上传；旧版可能仅支持读取。虽然连接器本身可以直接新建条目，插件的自动归档入口现在强制先用本地 API 查重；给已有条目追加附件使用 Zotero 10+ 本地 API。首次写入会弹出“DSH Zotero Flow”的授权窗口；选择允许或始终允许，不要提供 zotero.org 云端 API key。

### 逐篇全文获取：下载 → 精确关页 → 核验 → 查重归档 → 下一篇

系统提示和技能要求：PDF 确认落盘成功后，立即按本篇精确 PII/完整 DOI 或已核对文章 URL，仅关闭本篇文章页与 PDF 页；再调用 `scholar_session action=tabs`，核验本篇页面全部消失，之后才用本地 `pdfPath` 归档、处理下一篇。关页失败或核验未通过时暂停，保留本地 PDF，不重复下载。

保留浏览器窗口、空白页、扩展、机构登录及待人工处理的验证页；禁止按域名泛关或无参数全清。下载失败/超时/验证页不走下载成功的清理分支。已有本地 PDF 且没有对应打开页面的导入不需要此关页步骤。

**实现边界：**以上完整顺序是 agent 执行规则，并非浏览器代码的跨工具强制状态机。当前下载代码只尝试关闭抓取标签页，没有实现按 PII/DOI 清理所有本篇标签页并核验的自动门禁；需使用环境中已验证的精确关页能力，或由用户手工关闭后核验。下面的导入查重与追加附件则是代码强制执行。

### 自动导入：先查重，再补附件，最后才新建

`zotero_save` 与 `zotero_import_pdf` 默认执行这一规则，而不是依赖模型记得先调用搜索：

- 先检查库内已有书目和相同 PDF 文件哈希。唯一可靠身份匹配时复用原条目，只追加缺失的 PDF，保留原分类和元数据。
- 相同 PDF 已存在时跳过；已存在书目但文件不同则添加为新的子附件。
- 确认书目与相同文件都未命中时，才新建条目并添加 PDF。
- 多个候选、身份冲突、检索不完整或本地 API 不可用时停止，不能以检索失败为由直接新建。需要人工确认时使用下面的显式追加工具。
- 上传失败后保留并报告已有条目/不完整附件信息；失败不会自动降级为新建书目。

### 给已有条目追加 PDF（不重复建书目）

1. `zotero_search query="标题或 DOI"`，核对返回的 `key`，多个候选时先确认。
2. `zotero_attach_pdf itemKey="真实的8位key" pdfPath="本地PDF绝对路径"`。
3. 在 Zotero 中批准应用写入授权。工具创建 PDF 子附件，保留父条目与原分类；相同 MD5 的文件会跳过。此接口不新建父条目，也不会下载 PDF。
4. 如果上传中断，返回 `attached:false` 与已创建附件 key；应检查该不完整子附件后恢复，不要盲目重复创建。授权凭据仅在内存中保存，不写入日志或文件。

### 2. 先登录一次机构账号

第一次需要取全文时，agent 会调 `scholar_session action=start`，弹出一个**独立的浏览器窗口**
（资料目录默认 `%USERPROFILE%\.dsh-zotero-flow\edge-profile`，和你日常用的浏览器互不干扰）。

在这个窗口里完成学校登录（图书馆统一身份认证 / CARSI / WebVPN），**登录状态会长期保留**，之后每次取全文都复用它。

如果你的学校需要走 WebVPN 或 EZproxy 前缀，把前缀填进插件配置的 `institutionProxy`，例如：

```yaml
institutionProxy: https://webvpn.example.edu.cn/http/
```

---

## 和人配合的几条规矩

这个插件不是全自动爬虫。有三件事按规矩来：

**人机校验交给用户。** 页面出现验证码、滑块、点选或 Cloudflare 验证时，agent 会停下手上的步骤，
请你在机构浏览器窗口里手工过一次，等你回话再继续 —— 它不会自动识别验证码，也不会注入脚本伪装成人类。

**机构登录只提醒一次，之后复用。** 某个平台第一次需要机构登录时，agent 会提醒你在机构浏览器窗口登录
你的学校（SSO / CARSI / WebVPN）；之后同一个平台再取全文，它默认你已经登录好，先核实会话状态就直接继续，
不会反复打断你。机构和平台的登录情况记在 `%USERPROFILE%\.dsh-zotero-flow\institution-login-record.md`
（只记状态：机构、方式、入口、各平台是否已登录；不记密码、验证码、cookie 值或令牌）。
每次取全文前 agent 先读这份记录，判断「这个平台是已经登录好的，还是该提醒用户登录」。

**不做反检测规避。** 站点起疑时（403 / 429 / 验证页）正确反应是放慢节奏、交给用户、如实说明，
而不是想办法骗过检测：不注入脚本改写 `navigator.webdriver` 或指纹、不伪造 UA、不用打码服务、不伪造登录态。
一次只处理一篇，不做批量抓取。真实浏览器 + 你的真实登录态 + 人工过验证，这三样就够了。

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

**⑦ 不做反检测规避，也不自动过验证。**
站点起疑（403 / 429 / 验证页）时，插件与 agent 的动作是停下、放慢、把页面交回给你；
不去想办法骗过检测：不注入脚本改写 `navigator.webdriver` 或指纹、不伪造 UA、不用打码服务、不伪造登录态。
保持「真实浏览器 + 你的真实登录态 + 人工过验证」这三样，就够用了。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `Zotero 未响应` | Zotero 桌面端没开，或端口被改过（同步改 `zoteroPort`） |
| `本地 API 未开启` | 正常状态，只是分类树与库内检索受限；需要就按上文勾选 |
| `Zotero 挂载 PDF 失败（HTTP 500）` | 见「已知边界 ③」，通常是来源 URL 为空 |
| 浏览器起不来 | 未装 Edge/Chrome，或 `cdpPort` 被占用；用 `browserPath` 显式指定 |
| 抓不到 PDF | 页面需要登录 / 有人机校验 / 无订阅权限；`scholar_session` 的返回里会带「页面迹象」 |
| 页面出现人机校验 | 由你在机构浏览器窗口里手工过一次；agent 不刷新重试、不换入口试探、不自动过验证 |
| 某平台提示需要登录 | 先看机构登录记录：没登录过就提醒你登录；记录里已登录却仍停在登录页，说明会话失效，重新登录后更新记录 |
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
