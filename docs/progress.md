# 项目进度

核对日期：2026-09-23。本文汇总当前进度和下一步，不替代领域契约、运行手册或各阶段的历史验收记录。

Acornary 已从领域建模进入云端实际使用阶段：Codex／ChatGPT 通过 OAuth 和 MCP 管理同一份家庭库存，Web 登录后只读核对数据。下一项交付是首次正式版本的自动部署验收。

## 阶段与证据

| 范围 | 当前状态 | 证据及边界 |
| --- | --- | --- |
| 领域基线 | 已实现 | CatalogNode 目录树、Item 容纳树、对象内嵌属性、独立版本化模板、Event 和文字 Note；见 [领域模型](./domain-model.md) |
| Stage1 本地闭环 | 已完成验收 | 本地 Codex 写入、只读检查器、持久化与隔离恢复；[Stage1 验证](./stage1-verification.md) 保留历史结果，原正式本地库现已停写 |
| Stage2 云端与身份 | 已部署并完成验收 | 美国服务器为唯一正式库存，真实 Codex／ChatGPT 完成隔离写入验收及迁移后的正式授权、只读核对；见 [Stage2 验证](./stage2-verification.md) |
| GitHub CI | 已启用并通过 | main／PR 测试、Node 24 构建、真实 PostgreSQL 18、浏览器及发布控制器测试；核对时最新代码 `f2649b5` 的 [CI 通过](https://github.com/TANG617/Acornary/actions/runs/35838344952) |
| 镜像与部署设施 | 已配置并完成初始化验证 | 公开 GHCR、digest 部署、受限 SSH、发布锁、systemd 独立任务、按需备份及恢复规则；[手动 Release](https://github.com/TANG617/Acornary/actions/runs/35836631809) 仅构建发布，部署步骤跳过 |
| 首次正式 tag 自动部署 | 待执行 | 核对时远端无版本标签、服务器生产发布任务为零；尚未验证 GitHub 发布任务实际更新生产服务后，两个真实客户端继续读取 |

## 已有能力与保留边界

- 核心模型为 `catalog_nodes`、`items`、`attribute_templates` 三张表。属性是对象内嵌的模板绑定列表；数据库连同业务支撑与认证共 25 张表，只读检查器不展示认证秘密。
- MCP 支持目录、实例、属性、开封、整件／部分消耗、纠错、文字笔记和历史；同一领域服务维护家庭隔离、模板校验、版本检查、幂等和同事务事件。
- 工具写入仍要求明确对象 ID。自然语言解析和必要澄清由助手完成；服务没有 FEFO 或自动候选选择参数。
- 云端只有预置所有者，禁止公开注册。Codex／ChatGPT 使用独立 OAuth 授权，映射到既有同一 Actor／Household；Web 使用登录会话且业务只读。
- 日常定时备份按约定关闭。保留首次整库迁移快照；后续只有含新 migration 的自动发布才生成发布前备份，不自动做异机备份。

## 代码、镜像与线上状态

这三个状态分别核对，合入 main 或推送镜像不会单独更新生产应用。

| 对象 | 2026-09-23 核对结果 |
| --- | --- |
| 源码基线 | Stage2 与发布设施已整合进 main，保留 domain-model-v1 历史；本轮文档整理前为 `f2649b5fe2ce7a643a486d0d9d18f48f060b5a03` |
| 首个 GHCR 镜像 | `build-a0c250c8db26`，仅验证构建／推送／匿名拉取；早于随后提交的控制器和 SSH 修正，尚未部署生产 |
| 正式应用 | `acornary:stage2-a4009e05dcc08c2f`；仍为原 Stage2 镜像，完整镜像 ID 见 [发布验证](./release-verification.md) |
| 发布控制器 | 已安装修正后的控制器，当前记录为 `bootstrap`、`version=null`，生产发布任务为 0 |
| 健康检查 | 线上 `/health` 返回 `{"status":"ok"}`；`version`／`commit` 和迁移完整性检查代码随首次应用更新上线 |
| 入口与其他服务 | `https://acornary.protium.top` 正常，Runbuoy readiness 为 ready；本轮只读检查未重启或部署服务 |
| 本地原库 | 原应用与 PostgreSQL 均为 exited，仍保留停写保护 |

旧镜像构建时工作区尚未提交，因此 bootstrap 记录中的 `commit=1e23aa9…` 是原构建清单记录的 Git HEAD，不能据此认为线上缺少 Stage2。原清单中的源文件摘要和镜像 ID 才标识该次实际构建输入；新版本流水线使用完整 commit、版本与 digest 明确关联。

历史数据条数和双客户端核对结果保留在阶段验证记录中；本轮没有重新执行真实客户端授权／写入，也不把历史条数当作未来库存的固定约束。

## 下一步

1. 确认首个正式版本号，在通过 CI 的 main 提交上创建并推送 `vX.Y.Z`。本轮文档整理不创建标签或触发生产更新。
2. 按 [发布手册](./releases.md) 核对 Release 的测试、镜像 digest、服务器任务和最终状态；公网 `/health` 应返回目标版本与完整 commit。
3. Codex 与 ChatGPT 使用既有授权只读核对库存、笔记和历史，同时检查 Web 登录、匿名访问拒绝及 Runbuoy 路由。记录首次正式自动部署结果，再关闭该验收项。

附件／图片、OCR、主动提醒、模板设计与升级、FEFO、多用户、公开上架和离线同步继续后置；尚未将其中任何一项确认为下一阶段实施范围。长期负载、深树和异机灾难恢复也尚未验证。
