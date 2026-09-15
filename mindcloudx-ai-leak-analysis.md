# mindcloudx.ai 公开面泄漏分析

- 分析日期：2026-09-15
- 目标：`https://mindcloudx.ai`（3D Gaussian Splatting 云处理平台）
- 主体线索：页面备案号 `粤ICP备2024166230号`，公开资料对应深圳留形科技有限公司（Manifold Tech / 留形科技）
- 范围：仅检查浏览器可直接加载的页面、前端包、证书透明度记录，以及首页同款**未带登录态**的公开接口
- 明确未做：未使用下发的 STS 凭证访问对象存储，未枚举私有项目/分享码，未做目录爆破、登录爆破或漏洞利用

公开检索未发现针对 mindcloudx.ai 的既有媒体披露。本次结论来自当前线上公开面，而不是第三方泄漏库。

## 结论

最严重问题是：**未登录即可向 `/api/v1/common/getOssTemporaryKey` 换取阿里云 OSS STS 临时密钥**（AccessKeyId / AccessKeySecret / SecurityToken）。前端随后用这组凭证在浏览器里初始化 `ali-oss` 客户端，对存储桶 `3dgs-cloud` 执行 `put` / `multipartUpload`。

这不是“密钥写进了 GitHub”，而是**生产接口把云凭证发给任意调用者**。若 RAM 策略过宽，影响会从“可上传”扩大到对象列举或读取。本次**没有**用该凭证去验证策略范围，因此对象存储的真实爆破半径仍未知，但签发行为本身已经构成凭证泄漏。

次要问题包括：精选案例接口匿名返回内部项目/任务标识和带 STS 的签名 URL；CORS 配置不当；会话令牌放在 `localStorage`；缺少 `security.txt`。

## 资产画像

| 项 | 观察 |
| --- | --- |
| 产品 | Vue SPA，标题为 `3DGS`，提供训练、数据集、3DGS/Mesh/点云/CAD 查看与编辑 |
| 边缘 | 阿里云 ESA（`Server: ESA`，CNAME `*.a1.initba.com`，Cookie `acw_tc`） |
| 证书 | Let’s Encrypt / TrustAsia / DigiCert DV；存在通配符 `*.mindcloudx.ai` |
| 已知主机 | `mindcloudx.ai`、`www.mindcloudx.ai`、`k12.mindcloudx.ai`（3DGS Explorer）、`us.mindcloudx.ai`（另一套 Vue 包）、`worldfly.mindcloudx.ai`（解析到 `queniuaa.com`） |
| 存储 | 前端写死桶名 `3dgs-cloud`、加速域名 `oss-accelerate.aliyuncs.com` |
| 账号体系 | 路由守卫读 `localStorage.token`；项目/任务/积分/分享接口无 token 时返回会话过期；Google OAuth 与手机登录入口存在于前端路由 |

SPA 对未知路径回退同一份 `index.html`，因此 `robots.txt`、`/.well-known/security.txt` 实际不存在。

## 发现

### 1. 未认证签发 OSS STS（高）

- 接口：`POST /api/v1/common/getOssTemporaryKey`
- 未带 `Authorization` / `token` 时返回 `status: 0`，正文含 `AccessKeyId`、`AccessKeySecret`、`SecurityToken`、`Expiration`
- 本次观察到的过期时间约为签发后 6 小时
- 前端函数在拿到凭证后直接 `new OSS({ region, accessKeyId, accessKeySecret, stsToken, bucket: "3dgs-cloud", endpoint })`，并设置 `refreshSTSToken` 周期性再换票
- 业务用途是浏览器直传（`put` / `multipartUpload`），不是只读封面

对比：`POST /api/v1/project/list`、`/api/v1/task/list`、`/api/v1/credit/balance`、`/api/v1/share/get` 在同样匿名条件下返回“登录会话已过期”。STS 接口被单独放行，属于鉴权遗漏，而不是“全部 API 都公开”。

**建议（属方）：**

1. 立刻对该接口要求有效登录态，并按用户/项目签发**最小权限** STS（仅允许约定上传前缀的 `PutObject` / `InitiateMultipartUpload` 等，禁止 `ListBucket` 与跨前缀 `GetObject`）。
2. 轮换相关 RAM 角色与历史 STS；检查近几天对该角色的调用与桶访问审计。
3. 不要把长期可刷新的云凭证交到匿名浏览器。更稳妥的是服务端预签名上传 URL，或 STS 绑定单对象 key。

本次分析已触发至少一次匿名换票。即使请求方没有继续访问 OSS，属方也应视为凭证已暴露并轮换。

### 2. 精选案例接口暴露内部标识与签名 URL（中）

- 接口：`POST /api/v1/case/excellent/list`（首页 Featured Showcases 同源调用）
- 匿名即可得到约 10 条记录，字段包括 `id`、`project_id`、`task_code`、`task_name`、`project_name`、`cover_image`、`created_at`
- 封面对象位于 `public/cover_image/` 前缀，URL 带 `OSSAccessKeyId=STS.*`、`Signature`、`security-token`

若这些案例本就是运营展示，项目名与封面公开是预期行为。风险在于：

- `project_id` / `task_code` 是内部主键，可能被拿去撞其他接口（本次未验证是否存在 IDOR）
- 签名 URL 把 STS 查询参数完整放进可缓存、可转发的链接里，扩大了临时凭证的传播面

**建议：** 展示接口只返回公开字段；封面改为公共读或 CDN，不要把 `security-token` 塞进图片 URL。

### 3. CORS 与会话存储（低到中）

响应头同时出现：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Credentials: true`
- 允许头包含 `Authorization`、`token`

浏览器会拒绝“`*` + credentials”的组合，所以这不一定能直接被跨站带 Cookie 利用。但它说明 CORS 未按来源白名单配置。接口本身用 Header 里的 token，任意站点都可以直接调用。

会话 token 存在 `localStorage`。一旦出现 XSS，token 可被脚本读走。

**建议：** CORS 改为明确 Origin 白名单；会话改为 `HttpOnly` + `Secure` + `SameSite` Cookie，或至少缩短 token 寿命并绑定设备。

### 4. 前端信息暴露（低）

公开 JS（约 5.7MB）包含完整 `ali-oss`、业务 API 路径和桶名，未见硬编码永久 AccessKey。源码映射文件未放出。

可见 API 包括：配置、OSS 临时密钥、项目/分片上传、任务、积分、通知、分享、精选案例。登录相关路径在前端为 `/user/loginbyphone`、`/user/loginByGoogle` 等；同源 POST 被 nginx 以 405 拒绝，实际账号服务更可能走 `/cloudapi/v2`（匿名 `GET /cloudapi/v2/user/info` 返回 `token error`）。

### 5. 子域与安全联系通道（信息）

证书透明度可见 `k12`、`us`、`worldfly` 等主机，扩大了攻击面，但本次未对子域做深入探测。站点没有 `security.txt`，对外安全联系通道不清晰。官网宣传 SOC2，与当前匿名 STS 签发不一致。

## 未证实项

- STS 是否允许列出或读取 `public/` 以外的对象
- 分享/项目接口在持有 `project_id` 或 `task_code` 时是否存在越权
- `us` / `k12` 是否复用同一套 STS 接口
- 是否已有第三方把该接口纳入扫描并批量取票

以上需要属方用自己的审计日志和 RAM 策略确认，而不是继续对生产做未授权探测。

## 属方处置清单

1. 关闭或鉴权 `getOssTemporaryKey`，收紧 RAM，轮换角色。
2. 查 OSS / STS 审计：匿名取票后是否出现 List/Get/Put。
3. 精选案例与封面 URL 去标识、去 STS 查询参数。
4. 修正 CORS，迁移 token 存储，补 `security.txt`。
5. 确认展示案例是否均有发布授权。

## 方法边界

只使用了公开 HTTP 请求（首页资源、证书透明度、与首页同类的匿名 JSON 接口）。报告中的密钥、签名 URL、完整 `security-token` 均已删除。不要把本次描述理解成可复用的利用手册。
