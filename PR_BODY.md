## Summary

```text
文献落地页 → 核对 DOI/PII → 机构浏览器取 PDF
  ├─ 验证码 / 403 / 429 → 停止，保留页面，等待用户
  └─ PDF 校验通过 → 复用落盘文件 → 仅关闭插件拥有的对应标签页
                                      → Zotero 本机归档
```

- 保留本地 1.0.1 的工具/技能注册兼容改动。
- 增加 HTTP(S)、端口、CDP 本机端点、PDF 类型/128 MiB 大小与等待参数校验；移除任意 CDP Origin 通配符，Zotero 禁止 HTTP 重定向。
- 文档请求检查重定向目的地址；不将其声称为完整 DNS/子资源 SSRF 防火墙。
- 独占创建新 PDF，复用浏览器已有下载文件。关闭范围限于当前控制器创建的取全文页和仍停在原地址的关联文献页，保留登录窗口、用户页面及失败/校验页面。
- 校验或限流阻止自动归档/全文解析器回退；有界处理 OpenAlex 摘要位置。
- 默认 `npm test` 改为离线回归；原联网自检移至 `selftest:integration`。

## Evidence

- **Before:** 源码中浏览器启动含 `--remote-allow-origins=*`；本地 PDF 直接 `readFile`；下载通道落盘后再写副本；OpenAlex 稀疏索引没有上界；默认测试会访问真实服务。未运行旧版真实服务测试。
  **After:** `npm test`：19 passed / 0 failed，使用模拟 fetch、CDP 与 Zotero。覆盖非网页/私网字面量目的地、文档拦截、429 停手、校验后禁止 Zotero 回退、PDF 签名与大小、端口、稀疏摘要及已有路径复用。
- `node --check`：入口、browser、tools 通过。
- `git diff --check`：通过。
- `npm pack --dry-run --json`：17 个发布文件，无 PDF、profile、登录记录、凭据、host-inspect 或构建归档。
- 未运行真实浏览器、机构全文获取或 Zotero 写入测试；用户已停止文献获取，本 PR 不恢复这些操作。

## Merge Danger

**Door:** two-way

可回滚源码；没有迁移 Zotero 数据、删除浏览器资料或清理 cookie。尚未重新安装到用户当前插件。

**Blast Radius:** acquisition

严格 URL/端口/文件限制可能拒绝原先接受的本地服务、私网 IP 入口、超过 128 MiB 的文件或超长等待参数。域名形式的机构 WebVPN 仍支持。网页识别为启发式，不能保证识别所有验证码；DNS 重绑定、子资源请求和 CDP 响应体整体分配不是本 PR 提供的完整隔离边界。保留原始本地 PDF 导入功能；调用方仍须由用户授权所选文件。
留下的安全扩展项：元数据/连接器 JSON 响应完整流式限额、浏览器下载磁盘配额与长期清理策略。
