# Stage2 验证记录

日期：2026-09-23。状态：**Stage2 已完成：真实双端预验收、正式迁移、生产入口、正式授权和读取核对均通过。以下列出实际证据及验证边界。**

## 已通过

- Node 24 容器 TypeScript 检查与生产构建；linux/amd64 候选镜像在本机构建并传到美国服务器。
- Vitest：32 项通过。包括原领域回归、真实 PostgreSQL 事务／并发／防环／幂等／版本冲突、001–004 非空迁移保留检查，以及云配置失败关闭。
- OAuth 集成使用真实 Better Auth、PostgreSQL、JWT 签名与验证，外部 CIMD 文档抓取采用受控测试 fixture：匿名／错误入口／PAT／开放注册拒绝，安全 Cookie，既有 Actor／Household 绑定，CIMD、授权同意、PKCE、资源绑定、每工具 scope、幂等重放、5 分钟 JWT、刷新轮换、撤销与账号停用、错误 issuer／audience／过期令牌拒绝。
- Playwright 云模式：3 项通过。真实 Chromium 经过隔离 TLS 网关验证登录／退出／私有数据边界，双树、过滤、数据库原始记录、内嵌属性、模板版本跳转、笔记／历史、轮询／聚焦／手动刷新以及只读边界。
- DNS A 记录核对为 47.77.197.236。美国服务器 Runbuoy 原健康检查返回正常。
- AAAA／CNAME 无冲突。Caddy 已取得正式域名证书，公网 TLS 校验成功。用户交互创建预验收所有者后，应用启动并健康；公网 `/health`、`/login` 返回 200，匿名 `/api/context`、`/api/debug` 返回 401，`/mcp` 返回带资源元数据与 scope 的 401 OAuth challenge。授权服务器与受保护资源 discovery 均返回 200，CIMD 支持已声明。
- 共享 Caddy 已挂载持久站点目录并加入独立入口网络，保留 Runbuoy 原 172.30.77.10 地址与证书卷；修改后 Runbuoy 公网 /readyz 为 ready。发布脚本已追加持久覆盖文件，两份已有 Runbuoy release 的配置校验通过，未运行整站重新构建。
- 云运行账号 acornary_app 实测不能 CREATE public schema 对象、UPDATE auth_owners 或 UPDATE events；应用池上限 5，statement_timeout 为 15 秒。
- 备份 timer 已安装，状态 disabled / inactive；未生成正式库存的日常备份或迁移快照。
- 新增两个 OAuth 客户端并发修改同一物品的测试：一个成功，一个 REVISION_CONFLICT；同映射 Actor，revision 仅增加一次。
- 云预验收非空库手动备份后恢复到独立数据库 `acornary_restore_20260923042558`，25 张表的条数与完整行内容哈希全部一致。只测试了隔离库，没有对正式库存做日常备份。
- 真实本机 Codex 全局 MCP 连接已添加，CLI 返回 `Successfully logged in`；真实 ChatGPT 自定义 MCP 也完成 OAuth 连接。数据库确认两个官方 CIMD client ID 的刷新令牌均发生轮换，唯一启用的所有者映射到原有 installation 的 Actor／Household。两端业务操作闭环单独验收，不以授权成功替代。
- 预验收应用启动后抽样约 66–79 MiB／384 MiB，PostgreSQL 约 66 MiB／256 MiB；Codex 闭环后的 cgroup v1 历史峰值分别为 156631040 字节（约 149 MiB）、122331136 字节（约 117 MiB），两者 memory.failcnt 均为 0。这是本次运行负载的实测值，不是任意负载下的容量保证。运行角色执行 `pg_sleep(16)` 在 15025 ms 被 PostgreSQL 以 57014 取消，15 秒 statement_timeout 实际生效。
- 真实 Codex CLI 预验收已通过：45 次 MCP 调用完成目录、三个容器、六瓶牛奶、指定第一瓶开封／消耗 200 mL、带内容的箱子移动、笔记新增／修改与历史查询。服务端 SQL 独立核对选中瓶为 800 mL、revision 5，其余五瓶各 1000 mL、revision 1，完整数据库行（含时间）与操作前一致。原样重放旧 revision 的消耗请求返回相同 operation／结果，仅一个消耗 Event；箱子一个 MOVE，瓶子无派生 MOVE。关联 Actor 仅一个。客户端记录保存在本机忽略目录 `.local/stage2-acceptance/`。
- 用户在真实 ChatGPT 完成独立预验收操作，服务端 SQL 逐项核对通过：牛奶 `item_10be3ade-4bd9-4d75-bd58-bb49ebf2f9b2` 为 OPENED、800 mL、MEASURED、revision 5，笔记为“已开封，剩余800mL”；五个事件为 CREATE／OPEN／CONSUME_CONTENT／NOTE_CREATE／NOTE_UPDATE。箱子 revision 2，父节点为储藏室，仅箱子产生 MOVE；牛奶仍直接属于箱子，无额外移动事件。事件 Actor 与 Codex 相同。核对记录保存在 `.local/stage2-acceptance/chatgpt-database.json`。
- 预验收应用与 PostgreSQL 均停止后重新启动，11 张业务及支撑表完整行摘要一致；记录位于 `.local/stage2-acceptance/restart-{before,after}.json`。
- 正式停写已执行：原本地应用与 PostgreSQL 保持停止，`.local/stage2-cutover/SOURCE_STOPPED` 阻止原本地启动脚本重新启用。唯一快照 `database.sql` 已校验 SHA256，并恢复到新的 `acornary-production` 数据卷；只执行新增 004 认证迁移，不重新初始化业务身份。
- 正式云库与快照的 11 张原表逐行内容哈希全部一致：1 Household、1 Actor、13 CatalogNode、17 Item、7 模板、2 Note、37 Event、33 幂等操作、0 条码索引、1 installation、3 条原迁移记录。新认证表独立创建，预验收账号／令牌／业务数据未导入。核对记录位于 `.local/stage2-cutover/{business-manifest,cloud-business-manifest}.json`。
- 用户交互创建正式所有者后，唯一启用绑定指向原 Actor／Household，原业务摘要再次比较一致。生产应用健康启动；`acornary-ingress route production` 在共享发布锁内通过 Caddy 校验并加载，公网健康检查 200，匿名业务读取 401，Runbuoy `/readyz` 200。预验收应用与 PostgreSQL 已停止，数据卷保留。
- 正式服务拒绝旧本地 PAT（401）；真实 Codex 携旧预验收授权连接时，刷新返回 `invalid_grant: session not found`，无法建立 MCP。用户随后重新完成正式 Codex OAuth，CLI 返回成功。旧 ChatGPT 连接同样报告 `oauth_token_invalid_grant`，需独立重新授权。
- 切换为生产上游后，再次对 Runbuoy 当前 release 与持久站点覆盖做配置演练，Caddy 校验通过；未执行 Runbuoy 业务重新构建或发布。
- 正式 Codex 直接 MCP 完成 21 次只读调用且全部成功：13 个目录节点（含隐藏节点）、17 个 Item、7 个模板、2 条笔记；两类验收目录均不存在。实际读取 17 个 Item 详情及历史，记录在 `.local/stage2-acceptance/codex-production-direct-*`。首次尝试遇到元数据网络请求失败，并选用了尚未重新授权的 ChatGPT 同名连接；重验仅禁用该次 CLI 的 Apps 入口，并对本站设置进程级 NO_PROXY，未改动其他全局 MCP 或代理配置。
- 用户在真实 ChatGPT 完成正式重新授权和只读查询，确认 17 件物品、13 个目录节点（含隐藏）、2 条笔记且无验收目录。生产数据库确认两个官方 CIMD client ID 的独立授权均存在，均含 inventory:read／inventory:write／offline_access；唯一所有者仍绑定原业务身份。
- 双端正式授权和读取后，再次比较 11 张原表的全部行摘要，与迁移前完全一致，包含 37 条事件、33 条幂等操作；核对没有产生业务写入。记录在 `.local/stage2-cutover/post-authorization-manifest.json`。
- 文档 16 个 JSON 代码块解析通过，README／docs 本地链接存在，`git diff --check` 通过。

部署镜像为 `acornary:stage2-a4009e05dcc08c2f`，平台 linux/amd64；镜像 ID `sha256:599f62f862da97352c52d5291ac09466ede0743e9d83de1dadcf0645b6f58e97`。本机 `.local/releases/a4009e05dcc08c2f/manifest.json` 与服务器 `/opt/acornary/current/manifest.json` 保存运行源码文件摘要及 migration 摘要，服务器加载后核对镜像 ID 一致。构建时工作区尚未提交；该摘要标识实际构建输入，Git 提交记录另行标识源码与文档版本。

## 验证边界

- 真实 Runbuoy 下一次全量发布仍未执行，只进行了入口配置演练。
- 完整业务写入、并发、重启及恢复验证使用隔离环境；正式切换后只读核对，不为验收制造正式业务事件。
- 内存记录对应本次验收负载；大规模库存、深树、长期运行和异机灾难恢复未验证。

本地正式应用与数据库已停写，数据已恢复到独立云端生产库；未启用日常备份。已有 Stage1 验证记录保留为历史证据。

公开域名已指向生产库；真实客户端验收无待处理的用户步骤。本次源码、部署脚本和验证文档统一纳入 Stage2 Git 提交。
