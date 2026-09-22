# Stage1 验证记录

记录日期：2026-09-22（Asia/Shanghai）。工作分支：`domain-model-v1`。保留原有工作区修改，未提交或推送。

## 当前交付：属性内嵌，schema 003

属性绑定已直接存入 items.attributes / catalog_nodes.attributes，attribute_templates 继续独立。核心三张表、整个数据库十一张表；attribute_sets 已删除。正常写入由共享领域服务检查模板、版本、家庭、适用对象、唯一性和完整值；数据库只约束属性为非 null 数组，直接 SQL 可绕过属性语义校验。

本地服务已升级，保留全部原数据和工作区修改。HTTP／MCP 命令、输入和业务 attributes 三字段投影不变；绑定时间只在数据库行及“内嵌属性”区域展示。无变化请求不更新时间、revision 或 Event。

| 验证 | 实际结果 |
| --- | --- |
| Node 24 类型检查、Docker 构建 | 通过，宿主机 Node 未修改 |
| Vitest | 26 项通过：8 项领域／ID、17 项真实 PostgreSQL 集成、1 项非空 001→002→003 迁移测试 |
| 内嵌约束与时间 | 零绑定、多绑定、重复模板、非法版本／适用对象／values／结构、跨家庭模板均覆盖；局部更新保留其他绑定，清空后重绑生成新时间，无变化保存完整原行 |
| 并发及领域回归 | 属性并发得到一个成功、一个 REVISION_CONFLICT；并发消耗、防环、终结状态保护、批量回滚、未知值、计量、Note、条码约束继续通过 |
| 数据库责任 | SQL 非数组和 null 被拒绝；SQL 可写入非法数组，领域服务拒绝后续正常写入，调试 API 仍能忠实显示原行 |
| 正式非空备份副本 | 002→003 后所有原行及 27 个绑定逐字段一致，重复初始化相同；绑定时间微秒精度保留 |
| 迁移前真实请求重放 | 保留的旧应用镜像在另一独立副本创建六件、消耗一件 200 mL；迁移后重放 legacy_v1 入库与 unified_v1 消耗，原结果一致，全部数据库行不变 |
| 正式库升级 | 停写、最终备份后升级；只新增迁移登记，核心旧字段和所有辅助原行均保持，事件追加保护始终开启 |
| Web / Playwright | 2 项通过：两棵树、过滤、原始核心属性和时间、精确模板版本跳转、Note、安全预览、历史、分页、API 投影、派生路径、轮询／聚焦／手动刷新、只读边界 |
| 正式库 HTTP / SQL | 全部 11 张表分页读取后与直接 PostgreSQL 行 JSON 逐字段一致 |
| 正式 MCP SDK v2 | 认证连接成功，23 个工具、16 件物品查询、get_attribute_sets 三字段投影及路径查询兼容 |
| 本机浏览器 | 已打开实际牛奶记录，确认 revision=5、两个内嵌绑定及原有绑定时间，未执行正式业务写入 |
| 非空库重启和独立恢复 | 正式库 11 张表条数及 SHA-256 全部一致；另外通过独立 Web 测试库的 11 表重启／恢复 |
| 文档一致性 | 16 个 JSON 块解析、相对链接检查、4 个 Mermaid 图语法解析全部通过；当前基线没有独立绑定实体，历史 002 记录明确标注 |

正式迁移保留摘要：12 个 CatalogNode、16 个 Item、7 个模板、27 个内嵌绑定、2 条 Note、34 条 Event、30 条操作记录。迁移登记从 2 增为 3；其他支撑表原行不变。这些数值以最终备份和升级后检查时点为准。

最终迁移前备份：`.local/backups/pre-embedded-1790083326548/`；验证过的迁移后备份：`.local/backups/verified-1790083361933/`。目录权限 700、文件 600，均被 Git 忽略。旧镜像 `acornary-before-embedded-attributes` 仅与 schema 002 的备份配套使用，回退先恢复到独立数据库核对。

证据：`output/tests-embedded.log`、`output/e2e-embedded.log`、`output/build-embedded.log`、`output/embedded-migration-clone.json`、`output/embedded-migration-replay.json`、`output/embedded-migration-live.json`、`output/debug-embedded-live-sql.json`、`output/mcp-embedded-live-read.json`、`output/storage-acornary.json`、`output/storage-embedded.log`。恢复脚本输出文件反映最近一次运行，历史备份各自保存当时的 verification.json。

未验证项：本轮没有重新进行真实 Codex 人工多轮库存写入／歧义澄清；写入兼容通过真实 PostgreSQL 和 SDK 测试、旧镜像副本重放验证，不将其等同于人工 Codex 验收。模板推荐、继承、发布／升级、附件、FEFO、云托管均未实施；大规模深树性能及异机恢复未验证。

## 历史记录：schema 002 检查器与统一 ID

以下保留上一轮的实测事实，12 张表和独立 attribute_sets 描述仅适用于 schema 002，不是当前存储契约。

**本轮开发者检查器、统一 ID 与属性绑定简化已实施，并已更新本地服务。** 此结论覆盖下列实际测试和已有数据迁移，不代替尚未重新执行的真实 Codex 人工多轮验收。

### 历史交付

- 完整实体名称前缀加标准 36 字符小写 UUID；数据库 text、外键、HTTP、MCP、Web 及结构化历史引用一致。保留原 UUID 部分。
- `attribute_sets` 无独立 ID，以所属对象和模板键定位；业务 attributes 列表每项仅有 template_id、template_version、values。
- 两棵树只保存 parent_id；path_ids 按 include_path=true 递归查询。固定实体响应不再返回 object_kind；CatalogNode.kind 和混合引用的 kind 保留。
- Web 分为数据库记录、派生结果和 API 响应；按对象与固定检查视图覆盖 12 张表，显示列类型、约束、外键链接、完整 Markdown／安全预览、事件、指纹与操作结果，支持分页、复制、轮询和聚焦刷新。
- 独立只读调试查询直接返回 PostgreSQL `to_jsonb(t)`，保留全部列、null、时间和 JSONB；无任意 SQL、写入或凭证读取入口。
- 增量迁移 `002_unified_ids.sql`；旧指纹格式 legacy_v1 可规范化新格式请求后重放，新操作使用 unified_v1。迁移后事件及模板的追加保护恢复。

### 历史实际通过

| 验证 | 结果与边界 |
| --- | --- |
| Node 24 类型检查与 Docker 构建 | 通过；未修改宿主机 Node 26 |
| Vitest | 24 项：8 项纯领域／ID 校验、15 项真实 PostgreSQL 集成、1 项非空旧 schema 迁移 |
| 旧 schema 001 合成数据迁移 | 保留记录、UUID 部分、父引用、SKU 引用、属性、正文、时间、revision、指纹与事件关联；转换 Note 路径和缓存结果；追加保护恢复 |
| 正式库旧备份副本迁移 | 在独立临时数据库恢复并迁移；逐条、逐字段比较；重复初始化不新增身份 |
| 正式库增量迁移 | 停止应用写入、最终备份后应用；全部原记录按确定映射逐字段一致，无额外业务 revision 或 Event |
| 旧幂等重放 | 旧格式指纹配合新 ID 重放六件入库与部分消耗，返回同一结果，不重复新增或扣减；改变请求被拒绝，自由文本不替换 |
| HTTP 数据库记录对照 | 正式库 12 张表均通过分页读取，与直接 PostgreSQL 行 JSON 逐字段一致 |
| 身份、绑定、派生字段 | 旧／截断／错误前缀 ID 拒绝；绑定无 id、多模板可用、重复绑定拒绝；默认业务结果无 path_ids / object_kind；移动容器后子行完整快照不变，递归路径更新 |
| 权限与只读 | HTTP 写接口、无凭证 MCP、非法 Host / Origin、越家庭引用、未知表／SQL 参数均拒绝；合法调试查询按家庭隔离 |
| MCP SDK v2 HTTP | 测试库通过授权写入、工具发现、幂等重放和非法 Schema；升级后正式服务另通过认证查询、前缀 Schema、16 件物品查询和按需递归路径 |
| Playwright | 最终 2 项通过：双树、过滤、真实行与 HTTP 对照、多绑定、模板版本跳转、Note、安全预览、历史、操作分页、派生／API 分区、刷新与只读请求 |
| 本机浏览器 | 已在升级后的实际库存中打开目标牛奶，核对核心行、两个属性绑定、模板、笔记及完整历史 |
| 正式非空库重启及独立恢复 | 12 张表逐表条数及 SHA-256 全部一致；恢复到临时空数据库，不覆盖现有库存 |
| 文档一致性 | 15 个 JSON 代码块解析成功，文档相对链接检查通过；ID 样例、字段、模板绑定及视图区分已同步 |

既有领域／事务测试继续覆盖单瓶开封、部分消耗、未知库存语义、并发消耗、幂等冲突、批量回滚、终结状态保护、并发防环、容器能力保护、条码唯一、跨家庭、Note 修改和无变化请求、内容归零、SKU 编辑与计量纠错保留身份。

### 历史正式数据保留结果

| 表 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| households | 1 | 1 |
| actors | 1 | 1 |
| catalog_nodes | 12 | 12 |
| items | 16 | 16 |
| attribute_templates | 7 | 7 |
| attribute_sets | 27 | 27 |
| notes | 2 | 2 |
| events | 34 | 34 |
| operations | 30 | 30 |
| barcode_index | 0 | 0 |
| installations | 1 | 1 |
| migrations | 1 | 2 |

条数只是摘要；保存验证使用完整行比对。唯一新增行是 migration 002 的登记记录。正文、业务属性、revision、时间不变；实体 ID／结构化引用按前缀转换，属性绑定移除 id，旧操作增加 fingerprint_format。

最终迁移前备份：`.local/backups/pre-unified-1790079346865/`。迁移后已验证的完整备份：`.local/backups/verified-1790079403838/`。备份目录权限 700，数据库及凭证文件权限 600，不进入 Git。旧应用镜像保留为 `acornary-before-unified-ids`；旧镜像不能直接运行于新 schema，应按恢复流程使用匹配的数据库副本。

详细本地证据：`output/tests-inspector.log`、`output/e2e-inspector.log`、`output/id-migration-clone.json`、`output/id-migration-live.json`、`output/debug-live-sql.json`、`output/mcp-live-read.json`、`output/storage-acornary.json`、`output/playwright/`。原始数据和凭证仅位于忽略的本地目录。

### 当时未验证的范围

本轮未重新执行真实 Codex 的完整多轮写入及歧义澄清验收，也未重新发出正式库存写命令来验证这些交互。早期 Stage1 的 CLI 连接和查询曾通过，某次写入被该客户端审批策略拒绝；当前数据库已有用户审阅的库存和 MCP 来源历史，不能继续把正式库描述为空，也不能据此声称本轮完成了人工验收。后续完整交互验收可使用 [验收提示词](../scripts/acceptance-prompt.txt)，应先明确是否需要新增验收物品。

模板升级接口仍后置；检查器可以按版本显示已存注册记录，本轮真实数据只有 v1，没有验证升级业务。分页是每次请求的只读一致快照，不保证跨页期间其他客户端写入不改变页边界。大规模库存、深树性能和异机灾备恢复未验证。

OAuth、ChatGPT、附件、模板发布／升级、FEFO／自动选取和云托管继续后置。运行方式、直接 SQL 对照与迁移步骤见 [本地运行](./local-runtime.md)。
