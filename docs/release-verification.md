# 自动发布验证记录

日期：2026-09-23。此记录只描述自动发布新增能力，不改写既有 Stage2 双端验收结果。

## 隔离验证

- main 已 fast-forward 整合 domain-model-v1，保留全部历史。
- Node 24 容器内类型检查、32 项 Vitest（包含真实 PostgreSQL／OAuth）、构建、3 项 Playwright 通过；未启动停写的本地原库存。
- 15 项 Python／Node 发布测试通过：幂等重放、串行提交、版本倒退、版本身份冲突、迁移摘要变更、备份失败、事务回滚、启动失败、迁移结果不确定、进程中断、保留规则、发布记录写入失败，以及丢失 SSH 提交响应后使用同一身份重试并查询。
- 独立应用容器＋PostgreSQL 18：普通更新不备份；新增 migration 前备份并独立恢复；SQL 失败事务回滚；新应用启动失败恢复旧镜像；迁移已经提交而启动失败时停止应用、保留数据库。
- 更新后逐行核对 Item、CatalogNode、内嵌属性、Note、Event、幂等记录，重放旧入库请求不重复创建，既有 Web 会话继续有效。测试使用隔离账号、库存和本地镜像；这里不替代正式公网 OAuth 客户端验收。

## GitHub 与镜像

- [首轮 GitHub CI](https://github.com/TANG617/Acornary/actions/runs/35836581007) 通过，包含真实 PostgreSQL、浏览器和容器恢复测试。
- [手动 Release](https://github.com/TANG617/Acornary/actions/runs/35836631809) 测试与构建发布通过，production deploy 明确 skipped；未创建正式标签。
- 单独重跑同一工作流的 publish job 通过，复用既有版本镜像，deploy 仍为 skipped。
- 首个镜像 `build-a0c250c8db26`，源码 `a0c250c8db2614d11f30772ace3794c247b459e8`，digest `sha256:be2ddab8c395c0589f4f77a3daa91472bee55eabd0afbeb9ca00e9975c653792`。该构建早于随后补充的控制器边界修正；后续正式 tag 将使用自己的完整提交与 digest。
- [GHCR 包](https://github.com/TANG617/Acornary/pkgs/container/acornary) 已显示 Public。本机与美国服务器都使用空 Docker 登录配置按上述 digest 匿名拉取成功；未向服务器配置 GHCR 账号凭证。
- `production` Environment 只接受 `v*` tag，没有人工审批；部署主机／账号变量、专用 SSH 私钥及固定 Host Key 已配置。CI／镜像构建任务不读取生产 SSH Secrets。

## 服务器初始化

- 控制器、专用 `acornary-deploy` 账号和冻结 Compose 配置已安装。私钥未上服务器，服务器账号不加入 Docker 组。普通 `id` 命令被 forced command 拒绝；合法格式的状态查询通过 sudo 到达控制器，未知任务返回 rejected。
- Python 3.6.8 编译通过；systemd 239 使用 `Type=simple`。root 拥有 home／authorized_keys，`.ssh` 可读但部署用户不可写；已修正 root umask 导致 SSH 不能读取公钥的问题。
- 在独立 `/var/tmp/acornary-release-smoke-20260923` 使用 FakeBackend 测试 systemd worker：提交后主动终止 SSH 客户端，worker 完成；重新连接查询／重放返回既有成功结果。此测试不运行 Docker 或触碰正式数据库，真实迁移与容器恢复由上述隔离测试覆盖。
- 当前旧镜像 `sha256:599f62f862da97352c52d5291ac09466ede0743e9d83de1dadcf0645b6f58e97` 已登记为 bootstrap 恢复基线；四份已执行 migration 与原部署清单摘要一致。
- 正式应用未因初始化重启或更新。公网 HTTPS、OAuth discovery、匿名 context／MCP 拒绝、Runbuoy readiness 均通过。日常备份 timer 仍为 disabled／inactive，没有为无迁移初始化生成正式数据备份。

## 尚未执行

未创建或推送任何正式版本标签。首次正式 tag 的真实自动部署，以及随后 Codex／ChatGPT 读取，需在用户选择正式版本后执行；不能用手动 build-only 或隔离测试宣布此项通过。当前线上仍为 Stage2 旧镜像，`/health` 暂时只有 `status`；版本和 commit 字段随首次应用更新生效。

真实客户端 OAuth 授权在既有 Stage2 已验证。本轮确认了认证表／配置持久保留及隔离 Web 会话跨更新，但尚未在首次正式版本更新后重新核对真实 Codex／ChatGPT 的既有授权。
