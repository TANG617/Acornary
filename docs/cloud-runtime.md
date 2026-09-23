# Stage2 云端运行

目标地址：`https://acornary.protium.top`，MCP：`https://acornary.protium.top/mcp`。美国服务器 `47.77.197.236`。当前正式切换状态以 [验证记录](./stage2-verification.md) 为准，不能把预验收环境当成正式库存。

正式切换已完成，云端为唯一正式库存。后续自动发布设施已配置，但首次正式 tag 部署尚未执行；目前运行的仍是 Stage2 镜像。代码、构建镜像与线上状态的对应关系见 [项目进度](./progress.md)，不要将下文初次部署步骤重复执行到现有正式库。

## 运行模式与数据

`local` 保留回环地址、个人凭证与只读本地检查器。`cloud` 必须配置 HTTPS origin、32 字符以上 Better Auth secret、精确 Caddy 代理 IP、数据库连接；只接受 OAuth，Web 也必须登录。云应用启动不执行 migration，不自动创建 Household；缺少安装记录或所有者绑定时拒绝启动。

001–003 不修改。004 只增加认证表：user、session、account、verification、jwks、oauthClient、oauthResource、oauthClientResource、oauthRefreshToken、oauthAccessToken、oauthConsent、oauthClientAssertion、rateLimit、auth_owners。核心仍为 items、catalog_nodes、attribute_templates；原业务表十一张，加认证表十四张，共二十五张。检查器仅展示原十一张白名单表。

所有者绑定复用 `installations.slot=local` 中原有 Actor、Household，不因部署位置改变槽位。账号、客户端、scope 不由工具输入指定。授权检查发生在查询／写入／幂等重放之前。MCP 读写工具名称、参数、结果保持兼容。

## 构建、部署与入口

后续版本采用 [版本标签与自动发布](./releases.md)：GitHub Actions 构建并推送公开 GHCR 镜像，服务器按 digest 拉取、通过独立任务更新应用。服务器不执行生产构建。以下本机 `docker save`／SSH 流程保留用于初始 Stage2 部署和受信任的运维操作。

`node scripts/build-cloud.mjs` 生成按运行源码摘要命名的镜像，在 `.local/releases/<摘要>/` 保存 image.tar 和 manifest.json。部署使用其中的固定镜像名，不以滚动 latest 作为验收依据。

`compose.cloud.yaml` 将应用和 PG 放在独立项目；应用无宿主机端口，用户为 1000:1000、只读根文件系统、去掉 capabilities。应用内存 384 MiB、Node 堆 256 MiB、连接池 5；PG 256 MiB、连接上限 20、shared_buffers 64 MiB。请求 30 秒、数据库语句／空闲事务 15 秒；JSON 日志轮转 10 MiB×3。登录与 OAuth 端点使用数据库限流。

环境私有文件位于 `/etc/acornary/{preacceptance,production}`，目录 0700、文件 0600。`scripts/cloud-config.mjs` 在服务器内生成随机秘密，已有配置拒绝覆盖。`postgres.env` 用于迁移角色；`migration.env` 用于受信任 CLI；`app.env` 使用无 DDL 权限的 acornary_app。`deploy/grants.sql` 在 migration 后应用，运行账号不能修改所有者映射、既有事件或模板定义。

共享入口使用 `/etc/acornary/ingress/` 目录挂载；保留 Runbuoy 原网络 `172.30.77.10` 和证书卷，通过独立 `acornary-edge-v1` 的 `172.30.78.10` 连接 Acornary，Caddy 不接入数据库网络。`deploy/ingress.override.yaml` 追加到 Runbuoy Compose。发布脚本补丁会对每个 Runbuoy release 的原 Caddyfile 做合并校验，再加载持久 Acornary 站点。两者使用同一个部署锁。`check` 不修改正在使用的文件，也不执行 Runbuoy 构建。

首次变更挂载会重建 Caddy。上线前后检查 `http://127.0.0.1:8000/healthz`、公网 Runbuoy 路由和 Acornary TLS；原发布脚本保存于 `/etc/runbuoy/deploy-runbuoy.before-acornary`。源站点和上次入口配置保留用于恢复。只有 DNS A 记录指向美国 IP，不能代理到其他源；由 Caddy 管理证书续期。

生产应用健康后，在服务器执行 `acornary-ingress route production` 切换站点上游；该命令持有共同发布锁，保留原站点，校验后加载，失败则恢复原站点并重新加载。隔离验收使用 `route preacceptance`；正式写入开始后不能将其当作数据回退方案。Runbuoy 发布仍保留当前持久站点，不将上游改回预验收环境。

## 所有者和授权

在自己的终端交互执行，邮箱、密码不作为参数，也不要发送到聊天中：

```sh
ssh -t root@47.77.197.236 'acornary preacceptance owner create'
```

正式数据库切换后使用 `production`。其他命令：

```sh
acornary production owner reset-password
acornary production owner revoke-grants
acornary production owner disable
acornary production owner enable
```

撤销会删除授权同意和刷新令牌；访问 JWT 最多继续有效到原 5 分钟期限。停用账号会在每次请求的绑定检查中立即阻止后续访问。密码重置同时撤销会话和授权。公开注册、邮件恢复、多用户管理均关闭。

Codex 全局连接（保留其他 MCP 配置）：

```sh
node scripts/codex-cloud.mjs connect
node scripts/codex-cloud.mjs doctor
node scripts/codex-cloud.mjs disconnect
```

连接要求 CIMD，并申请 inventory:read、inventory:write、offline_access；令牌由 Codex 管理，不把 PAT 写进全局配置。已有同名且不同地址的配置会拒绝覆盖，需先检查。ChatGPT 在账号开发者模式中创建自定义 MCP Plugin，填入正式 MCP HTTPS URL 并选择 OAuth，完成浏览器登录和授权。仅个人账号内连接，不做公开上架，也不需要 OpenAI API key。

Codex 也可能同时看到从 ChatGPT 同步的同名 Plugin；它与全局 MCP 使用独立授权。`server=acornary` 是直接 MCP，`server=codex_apps` 是同步连接。同步连接提示 `oauth_token_invalid_grant` 时在 ChatGPT 重新授权；元数据网络请求失败则先检查到本站的网络／代理，不能把网络失败当成账号错误。诊断可以仅对该次进程将本站加入 NO_PROXY，避免修改其他服务的代理配置。

授权码使用 PKCE S256，动态客户端注册关闭；客户端元数据由 Better Auth 的 CIMD 安全抓取器解析，限制重定向、私有地址和 DNS 重新绑定。签名密钥由 JWT 插件持久保存。访问令牌 5 分钟；刷新令牌 30 天、每次轮换，旧刷新令牌不能重用。Web 使用 Secure／HttpOnly Cookie，没有业务写表单。服务日志只关联已验证的 OAuth client ID、工具名和 operation_id，不记录 OAuth URL、Cookie 或令牌。

## 预验收与正式切换

1. 独立 `acornary-preacceptance` Compose 项目初始化测试库，创建测试所有者。完成真实 Codex、真实 ChatGPT 的查询／入库／开封／部分消耗／移动／笔记闭环，以及 Web 核对、并发、重启和恢复检查。SDK 测试不替代真实客户端验收。
2. 双端通过后，执行 `node scripts/cutover-snapshot.mjs --preacceptance-verified`。脚本停止本地 app，生成 `.local/stage2-cutover/database.sql`、业务摘要和校验和；无论成功或失败都不自动重启。目录已存在时拒绝覆盖。
3. 创建新的 production 配置、项目与空数据库，将唯一快照恢复进去；执行 004 migration、运行角色授权、交互创建正式所有者。不得导入预验收认证数据或重新初始化业务安装。
4. 使用 `scripts/inventory-manifest.ts` 比较原十一张表：按 PostgreSQL 行 JSON 排序后哈希，包括原 migrations 001–003；只排除新登记的 004。任何业务摘要不一致都停止切换。原 UUID、属性、revision、时间、笔记、事件和幂等结果必须完全相同。
5. 将入口 upstream 切到 `acornary-production-app:3210`，经同一个部署锁校验并加载；停预验收 app。Codex／ChatGPT 重新授权。旧测试令牌使用不同签名密钥／认证库，不能访问正式服务；本地 PAT 始终不能访问云端。
6. 双端读取正式既有数据核对。本地原库保持停写；本地开发只能使用独立数据库／Compose 项目。不要再执行旧的 `local.mjs start/init` 或旧备份脚本使原 app 复活。

迁移前历史幂等作用域和 fingerprint_version 保持不变。重试必须保留键和参数；不同幂等键不提供语义去重。云端首次正式业务写入前，可以恢复入口并重启本地原库；已有云端写入后，必须先停写并保全最新云端数据，恢复兼容版本，不能用旧迁移快照覆盖。

切换脚本成功后也会停止原本地 PostgreSQL，并保留 SOURCE_STOPPED 标记；local.mjs 的 init／start／codex／backup 会拒绝重新启动原库存。回退前先停止 production app，比较 `acornary production manifest` 和一次性快照的 business-manifest.json；只有业务内容仍一致、且确认未接受正式写入时，才能将 SOURCE_STOPPED 留档改名并 `docker compose start postgres app`，断开云 MCP、恢复原本地连接。若摘要不同，先对最新云库做手动保全，再设计兼容恢复，不能解除标记直接重启旧库。共享 Caddy 的回退只针对 Acornary 站点，不撤销 Runbuoy 已有服务。

## 备份边界

**日常备份默认关闭。** Stage2 首次切换仅生成一次迁移前快照；后续自动发布仅在出现新增 migration 时生成发布前备份，无迁移更新不生成备份。恢复功能测试使用隔离库，没有异机备份链路。以下命令只有操作者显式执行时才生成备份或启用日程：

```sh
acornary production backup-status
acornary production backup
acornary production restore-test /path/to/database.sql
acornary production verify-restore acornary_restore_20260923040000
acornary production backup-enable
acornary production backup-disable
```

手动备份落入服务器 `/var/lib/acornary/backups/production/<UTC时间>/`，包含认证数据，权限 0700／0600。restore-test 总是创建独立 `acornary_restore_<时间>` 数据库，不覆盖当前库，也不挂载应用。可选 systemd timer 安装但不启用；显式启用后每日 UTC 04:00 在本机备份，无自动异机复制。恢复还需要匹配版本的应用与保密的 Better Auth secret；不能只恢复数据库后随意更换 secret。

verify-restore 逐表比较行数和完整 PostgreSQL 行内容哈希，不打印认证原文。比较时源库应停写；源库在备份之后发生变化也会报告不同，应保留两个库核查，不自动覆盖。

## 测试入口和证据

`node scripts/test-stage2.mjs` 在 Node 24 测试镜像内使用独立 acornary_test；`node scripts/e2e-cloud.mjs` 使用临时数据库和临时自签 TLS 网关执行 Playwright，不接触正式库。验证分别记录自动化、真实 Codex、真实 ChatGPT、云部署、正式迁移和恢复结果。

协议依据：[Better Auth MCP](https://better-auth.com/docs/plugins/mcp)、[CIMD](https://better-auth.com/docs/plugins/cimd)、[OpenAI Plugin authentication](https://developers.openai.com/plugins/build/auth)。
