# Acornary documentation

本目录记录 Acornary / 松仓 v1 的唯一产品与工程基线。Stage1 代码已落地，实际通过与尚未通过的验证见 [验证记录](./stage1-verification.md)。

Stage2 已完成真实双端预验收、正式数据迁移与入口切换，两端正式授权和读取核对均通过。美国云端为唯一正式库存，本地原库停写；Codex／ChatGPT 使用 OAuth，Web 登录后只读。实际验证及边界见 [Stage2 验证](./stage2-verification.md)，操作见 [云端运行](./cloud-runtime.md)。以下 Stage1 段落描述本地模式与历史阶段，不表示云模式允许匿名读取或个人凭证访问。

Stage1 约定为同一电脑上的本地部署：Codex 通过带个人访问凭证的 MCP 操作明确 UUID 的库存和文字 Note；Web 无需登录，仅作只读开发者检查器，核心模型为三张表，按对象覆盖数据库全部 11 张表，分开显示数据库记录、派生结果和 API 响应。自动选取与 FEFO、模板升级、图片附件、云托管、ChatGPT、HTTPS、OAuth、注册登录及后台任务后置。长期技术方向保留，阶段边界统一记录于 Architecture，不另立平行方案。

## 阅读顺序

| 文档 | 内容 |
| --- | --- |
| [版本发布](./releases.md) | GitHub Actions、公开 GHCR、受限 SSH、迁移备份与恢复 |
| [发布验证](./release-verification.md) | 流水线、服务器配置和首次正式标签的验收边界 |
| [云端运行](./cloud-runtime.md) | Stage2 部署、OAuth、账号运维、切换与备份开关 |
| [Stage2 验证](./stage2-verification.md) | 自动化、真实双端、云环境与正式迁移分别记录 |
| [本地运行](./local-runtime.md) | 启动、停止、Codex 连接、测试和备份恢复 |
| [验证记录](./stage1-verification.md) | 自动化证据、真实 Codex 结果及未完成项 |
| [Domain model](./domain-model.md) | CatalogNode / Item 两棵树、稳定身份、最小字段、七个可选属性模板、事件与不变量；包含静态关系图 |
| [Architecture](./architecture.md) | Stage1 本地运行、MCP 写入与只读 GUI、技术栈、公共命令、事务、后续阶段及验收 |
| [Examples](./examples.md) | 明确 UUID 的牛奶／鸡蛋操作、局部更新、容器移动、文字笔记、失败场景及 Stage1 验收；后续能力单独标注 |
| [Product language](./product-language.md) | 品牌语言与领域术语的对应 |

## 一句话模型

**CatalogNode 定义分类和商品，Item 用独立 UUID 表示每件实物并形成容纳树；业务属性由模板扩展，变化由 Event 记录，用户记忆由 Note 和附件保存。**

| 问题 | 数据来源 |
| --- | --- |
| 它是什么？ | Item.catalog_node_id → CatalogNode SKU 及其 GROUP 祖先 |
| 具体是哪一件？ | Item UUID；六瓶牛奶是六个不同 UUID |
| 在哪里？ | Item.parent_id 形成的容纳树，完整路径由查询推导 |
| 有多少件／剩多少？ | current_count 及其中的 unknown_lifecycle_count／各实例 contents.remaining；分别统计 |
| 品牌、条码、日期、状态是什么？ | 对象内嵌 attributes 绑定固定版本的 AttributeTemplate |
| 经历了什么？ | 以对象身份和 operation_id 查询 Event |
| 有哪些文字、图片与故事？ | Item → Note → NoteAttachment |

家、厨房、抽屉可以引用隐藏的通用容器 SKU，实际冰箱或行李箱可以引用真实 SKU；容纳能力由实例模板明确声明。目录隐藏仅用于展示，不能替代权限控制。

模板统一为 product、lifecycle、contents、container、catalog、clothing、device。字段默认可选；lifecycle.expiry.date 可以单独填写，更新 lifecycle.opening.state 不覆盖其他已知属性。未记录生命周期状态的 Item 仍可参与日常库存与明确操作，但不能把未知描述为 ACTIVE 或 AVAILABLE。

文档修改必须同步检查字段表、图示、模板、MCP 示例和验收场景。领域语义以 Domain model 为准，接口细节与阶段范围以 Architecture 为准；不保留平行架构草稿作为另一套模型。
