# 版本标签与自动发布

正式发布链路：合入 `main` → 推送 `v主版本.次版本.修订号` → GitHub Actions 测试 → GHCR 镜像 → 受限 SSH 提交服务器任务 → 停服、按需迁移、启动与核对。

本流程允许短暂停服。业务模型、数据库卷、所有者、OAuth 签名密钥及授权记录保持持久；不会自动升级 PostgreSQL、重建 Caddy 或修改 Runbuoy。实际配置与测试结果见 [发布验证记录](./release-verification.md)。

## 工作流

- `CI`：分支 push、PR，以及 Release 调用。Node 24 容器内执行类型检查、Vitest、真实 PostgreSQL 18、构建和 Playwright；另执行 Python 发布控制器测试及独立容器迁移／恢复测试。数据库、网络、账号与 TLS 都为临时测试资源，不读取本机 `.env`。
- `Release`：推送 `v*` 标签。拒绝无效版本及不在 `main` 历史中的提交。正式 `vX.Y.Z` 自动部署；`vX.Y.Z-rc.1` 等预发布版本只测试与发布镜像。
- 手动 `workflow_dispatch` 始终只测试、构建和推送 `build-<commit前12位>` 镜像，不部署。初始化使用此入口，不创建正式标签。

镜像为公开的 `ghcr.io/tang617/acornary`，目标 `linux/amd64`。OCI 标签及 `/app/release.json` 保存版本、完整 Git commit，后者包含 migration 文件 SHA256。服务器只部署 `@sha256:…`；相同版本重复构建复用已发布且身份匹配的 digest，不覆盖已有版本。第三方 Actions 固定完整提交 SHA，升级需评审。

工作流串行执行发布且不取消正在运行的发布。GitHub 并发队列并非持久的逐版本交付队列，密集推送多个标签可能替换尚未运行的待处理工作流；不要把逐标签执行用于数据库正确性。每个新镜像包含全部累计 migrations，服务器仍拒绝版本倒退。需要发布每个标签时，应等待上一轮结束再推送。

## 一次性配置

1. 从可信工作区复制 `deploy/` 与 `compose.cloud.yaml` 到服务器独立目录。生成专用 Ed25519 部署密钥，私钥不进 Git；通过现有可信 root SSH 获取并固定服务器 Host Key，不在流水线中盲目信任 `ssh-keyscan`。
2. root 执行 `python3 <可信目录>/deploy/bootstrap-release.py <部署公钥文件>`。它核对当前容器与原部署清单，登记当前镜像 ID 为初始恢复版本，安装控制器、冻结 Compose 配置和受限账号；不停止应用、不修改数据库。仅运行一次。
3. GitHub 创建 `production` Environment，只允许 tag 模式 `v*`，无人工审批；变量 `DEPLOY_HOST=47.77.197.236`、`DEPLOY_USER=acornary-deploy`，Secrets 为 `DEPLOY_SSH_KEY` 和 `DEPLOY_HOST_KEYS`。仅生产部署任务访问该 Environment。镜像发布任务仅用临时 `GITHUB_TOKEN` 的 `packages:write`。
4. 手动运行 Release，仅构建发布镜像。首次 GHCR package 默认私有，在包设置中改为 Public，然后使用无 Docker 登录配置的服务器验证匿名 digest 拉取。参见 [GHCR 官方说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

SSH 专用账号没有 Docker 组权限。root 管理其 home／authorized_keys，`restrict` 与 forced command 只允许 `start <version> <commit> <digest>`、`status <job_id>`。部署脚本、Compose、环境与日志由 root 控制；日常版本不从镜像自动替换部署控制器或 Compose。修改基础设施需单独受信任的运维操作。

## 服务器任务与检查

配置：`/etc/acornary/release.json`；当前版本：`/var/lib/acornary/releases/current.json`；已知迁移摘要：同目录 `schema.json`；任务日志：`jobs/<job_id>.json`。密钥、数据库连接与账号仍位于 `/etc/acornary/production/`。

1. 提交校验版本及唯一身份，取得提交锁。同版本同 digest／commit 返回已有任务；已有发布进行中或需人工恢复时拒绝其他发布。低于当前成功版本的请求拒绝。
2. systemd 独立运行 `acornary-release-<job_id>.service`，取得发布锁。SSH 中断不终止服务；重连先查询相同任务，绝不另起迁移。
3. 停服前核对磁盘空间、镜像平台／身份和已执行 migration 的摘要。已执行文件不得删除或更改。
4. 应用接收 SIGTERM，通过 Fastify 关闭等待请求完成，45 秒后强制终止；未提交事务由 PostgreSQL 回滚。只有应用停止后才备份或迁移。
5. 无新 migration 不生成备份。有新 migration 时先用 `pg_dump -Fc` 保存完整数据库、验证 archive 目录并记录 SHA256；然后一个事务执行全部新增 SQL、迁移登记和运行角色授权。
6. 仅启动 app。除容器健康外，检查公网 HTTPS `/health` 的 `status/version/commit`、登录资源、OAuth discovery，以及匿名 `/api/context`、`/mcp` 均返回 401。`/health` 还检查版本所需 migrations 已登记。
7. 成功记录当前版本、任务中的上一版本及 digest。默认保留当前及最近两个成功应用镜像、最近三份成功迁移备份；失败任务关联备份不自动清理。初始恢复镜像及历史任务 JSON 留档，不使用全局 Docker prune。

migration 必须遵守现有事务约定，不得在 SQL 文件内显式 COMMIT、写外部系统或引入不能事务回滚的操作。新增表所需写权限应同步更新镜像中的 `deploy/grants.sql`。修改已执行 SQL 会在停服前被拒绝。

## 日常操作与故障恢复

选择未使用且递增的正式版本，合入 main 后创建并推送附注标签，例如下方的版本仅作命令格式说明：

```sh
git switch main
git pull --ff-only
git tag -a v0.3.0 -m 'Acornary v0.3.0'
git push origin v0.3.0
```

不得移动／复用已发布标签。查看 Actions 的镜像摘要、部署任务 ID 与结果。健康接口可以公开检查，但不包含业务数据或认证秘密。

断线或超时后在服务器查询，不把 GitHub 超时当作服务器失败：

```sh
acornary-release status <job_id>
journalctl -u acornary-release-<job_id>.service
```

- 停服前失败：旧服务继续运行。
- 未修改 schema 的启动失败：恢复上一镜像并检查，任务仍为 failed。
- 迁移命令失败且完整迁移登记与迁移前完全相同：按事务回滚处理，恢复上一应用。
- SQL 已提交、结果不确定、进程被杀或恢复检查失败：`needs_attention`，禁止自动回退和后续发布。数据库与备份保持原状，不自动恢复旧快照。

`needs_attention` 必须由 root 排查任务 JSON、数据库 migration 登记和 systemd 日志。优先准备兼容当前 schema 的修复版本；若决定回退，先停写并保全最新数据，在独立数据库验证恢复，不能用旧快照覆盖新业务记录。完成调查后，运维人员在持有 `deploy.lock` 且确认 worker 已停止的情况下归档原任务，并以带原因、时间的运维记录解除该任务阻塞；不得删除任务或假称发布成功。当前版本／schema 摘要必须与核对结果保持一致。该处是异常人工恢复，不是每次发布审批。

备份在 `/var/lib/acornary/backups/releases/<job_id>/`，仅保存在本机。日常定时备份仍关闭。恢复命令使用现有 [云端运行](./cloud-runtime.md) 的独立数据库流程，并核对 archive 校验和；不得对正在运行的正式库直接 restore。

首次正式标签后的真实验收仍需核对 Actions、线上版本及 Codex／ChatGPT 读取。CI／手动构建成功不等于该正式自动部署闭环已经发生。
