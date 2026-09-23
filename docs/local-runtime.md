# Stage1 本地运行

Stage1 的运行代码已落地。自动化测试与真实 Codex 验收分别记录在 [验证记录](./stage1-verification.md)；运行服务不代表所有验收项已完成。领域与接口继续以 [领域模型](./domain-model.md) 和 [架构](./architecture.md) 为准。

## 启动与停止

需要 Docker Engine / Docker Desktop、Docker Compose、可运行脚本的宿主机 Node，以及已登录的本机 Codex CLI。宿主机 Node 26 可以保留：安装依赖、编译、服务运行、Vitest 和 Playwright 均使用 Node 24 容器，宿主机脚本仅编排 Docker 或启动 Codex。

在仓库根目录执行：

```sh
node scripts/local.mjs init
node scripts/local.mjs status
```

首次 `init` 创建随机数据库密码和 MCP 个人凭证，写入权限为 600 的 `.env`、`.local/token`，随后构建并启动。重复执行不会轮换凭证、重建家庭或覆盖数据。默认 Web 为 **http://127.0.0.1:3210**，数据库不发布宿主机端口。初始化后的正式库存为空，仅有一个隐藏的通用容器 SKU。

```sh
node scripts/local.mjs stop
node scripts/local.mjs start
```

停止不删除持久卷。需要改变 Web 端口时修改 `.env` 中的 `ACORNARY_PORT`，然后执行 `node scripts/local.mjs init`。已有家庭的时区保存在数据库中；环境变量 `HOUSEHOLD_TIMEZONE` 只决定首次初始化时区。不要在已有数据库上直接改 `.env` 的数据库密码。不要运行 `docker compose down -v`，该命令会删除数据卷。

## Codex 连接

启动一个带 Acornary 连接配置的本地 Codex 会话：

```sh
node scripts/local.mjs codex
```

脚本只在子进程环境中加载 `ACORNARY_TOKEN`，不会把凭证明文放进参数、终端输出、Git 或 Web。它向 Codex 传入等价配置：

```toml
[mcp_servers.acornary]
url = "http://127.0.0.1:3210/mcp"
bearer_token_env_var = "ACORNARY_TOKEN"
```

不修改全局 Codex 配置。仅复制这段配置不能自动给其他 Codex 进程加载环境变量；桌面应用需自行采用其支持的凭证加载方式。本轮实际验证的连接入口是本机 Codex CLI。

服务凭证授权和 Codex 自身的工具审批是两个独立检查。若客户端显示 `MCP tool call requires approval, but approval policy is never`，服务不会收到该写请求；不能把它当作入库成功。需要用户在允许交互审批的 Codex 会话中批准写工具。本轮已准备完整验收提示词 [acceptance-prompt.txt](../scripts/acceptance-prompt.txt)，可在会话内提交。

当前实体 ID 均为完整前缀加 36 字符 UUID，例如 `item_11111111-1111-4111-8111-000000000001`；MCP、Web 与数据库一致。升级后应重新查询 ID 和 revision，不再发送裸 UUID 或旧目录前缀。旧幂等请求使用原键、原参数语义和新格式 ID 重试，服务按旧指纹规范化验证后返回原结果。

可以先说：“查询我的目录和物品，列出可用模板。”随后明确创建商品、容器和物品。Codex 应先查询 UUID 与 revision，再提交写入；存在多个候选时向用户澄清。服务只接受明确 ID，不提供选取策略。

## Web 与接口

浏览器无登录，所有业务请求都是只读 `GET`：

- `/api/context`：当前家庭和隐藏通用容器 SKU 的 ID。
- `/api/read/<operation>?input=<URL 编码的 JSON>`：仅允许八个查询操作，与 MCP 使用同一服务和 Schema。
- `/api/debug?input=<URL 编码的 JSON>`：固定对象关系和系统视图；直接返回 PostgreSQL 行、列类型和约束，支持分页。
- `/health`：数据库连接健康检查。
- `/mcp`：带 bearer 凭证的官方 SDK v2 Streamable HTTP。

GUI 支持双树展开、名称／条码／生命周期／日期过滤、目录或容器范围跳转、详情、复制 ID、模板、Markdown 笔记、历史及数据库记录、派生结果与 API 响应。每 5 秒、返回页面和手动点击时刷新。Markdown 不执行原始 HTML；浏览器不持有 MCP 写入凭证。同源和 Host 检查拒绝外部网页调用本地接口，未配置跨域访问。

## 工程结构与当前限制

```text
apps/server/src/      HTTP/MCP 适配、应用用例、事务、初始化
apps/web/src/         React 只读模型检查器
packages/contracts/  Zod 命令与七个模板 v1、公开 Schema
packages/domain/     计量、路径变更、事件差异、生命周期规则
migrations/          显式 PostgreSQL migration
scripts/             本地启动、测试、备份、独立恢复核对
```

每个家庭的写请求先取得同一事务 advisory lock，再检查幂等和 revision。Stage1 以单家庭串行写换取简单、可验证的并发行为；不是高吞吐多租户实现。读取使用 REPEATABLE READ 只读事务。树查询使用递归 CTE；当前过滤和汇总仍会读取家庭范围数据，分页上限 200、批量创建上限 100。大量库存和深树的性能尚未验收，后续可按实际负载将筛选／聚合下推 SQL。

Measurement.value 和设备功率为十进制字符串；输入最多 80 个字符，运算精度 200 位。内置内容单位为 mL、g、count、percent，Stage1 仅同单位扣减；百分比不混入物理量总和。条码支持 1–128 位无空白的可打印 ASCII 标识（包括常见商品码和内部码），区分大小写，并保持同家庭唯一映射；未引入特定 GTIN 制式识别或校验位计算。模板发现接口给出受支持字段、枚举与范围。

当前数据库不包含附件或云端认证表，不提供硬删除、模板升级、自动选择和 FEFO。初始化种子是部署元数据，不产生用户操作 Event；之后业务写入统一记录实际变化。

## 自动化验证

```sh
node scripts/test.mjs
node scripts/e2e.mjs
```

第一条在 Node 24 容器安装锁定依赖并运行类型检查与 Vitest；数据库为专用 `acornary_test`，每个测试使用新家庭，不清空正式库存。第二条构建应用与 Chromium 测试镜像，创建独立临时数据库、六瓶牛奶等合成测试数据，执行 Playwright 和非空数据重启／备份恢复核对，最后清理临时容器和数据库。测试截图与日志放 `output/`；第一次安装 Chromium 依赖需要几分钟。存储核对会短暂停止本地正式应用和 PostgreSQL，期间避免操作。

真实 Codex 的端到端确认独立于 SDK 测试和合成浏览器数据；只有用户实际批准并完成 [验收提示词](../scripts/acceptance-prompt.txt)，再核对 GUI 和历史，才能关闭该验收项。

## 备份与独立恢复

```sh
node scripts/local.mjs backup
node scripts/verify-storage.mjs
```

`backup` 暂停应用写入，使用 `pg_dump`，然后重启应用。输出目录 `.local/backups/<时间>/` 包含 `database.sql`、`app.env` 和 `token`；目录权限 700、文件权限 600。备份包含凭证，只应保存在受控位置。该目录默认被 Git 忽略。

`verify-storage` 对正式数据库逐表记录条数与排序后的行内容 SHA-256，停止／启动 PostgreSQL 后比较，再恢复到自动生成的独立空数据库并比较全部表。恢复数据库核对后删除，不覆盖原数据库。报告保存在备份目录的 `verification.json` 及忽略的 `output/` 中。该检查覆盖 ID、引用、模板、属性、Note、Event 和幂等结果，并复制配置和凭证；未验证异机恢复。

需要手动检查某个备份时，可以在同一 PostgreSQL 内创建独立目标（使用未占用的新数据库名）：

```sh
docker compose exec -T postgres createdb -U acornary acornary_manual_restore
docker compose exec -T postgres psql -U acornary -d acornary_manual_restore -X -v ON_ERROR_STOP=1 < .local/backups/选定备份/database.sql
```

不要将恢复目标写成已有正式数据库 `acornary`。正式替换、跨机器恢复和凭证轮换需另行执行有明确目标的运维操作，本轮脚本不会自动替换。

## 开发者检查器与直接 SQL 核对

选中目录或物品，在“数据库记录”区域逐表查看核心行、全部属性绑定、对应模板版本、笔记、事件与操作。绑定是核心行 attributes JSONB 数组的成员，保存模板键、版本、values 和绑定时间，无独立 ID、所属外键或家庭字段。内嵌属性区域展开该列，不伪造独立表；原业务及支撑表共 11 张，其中 3 张是核心模型表。004 migration 另增 14 张认证表，不进入检查器。列类型与约束可展开，关联按钮可跳转。固定检查视图覆盖家庭／操作者、全部注册模板、操作、笔记、事件、条码索引、初始化和迁移信息；没有事件的无变化操作也可从全局操作记录找到。

“派生结果”中的 path_ids 来自 parent_id 递归，商品名称来自 SKU，提醒依据来自 lifecycle；它们不是核心表列。“API 响应”显示实际业务查询的结果，attributes 是仅含 template_id、template_version、values 的列表。默认业务查询不返回 path_ids，需要时显式传 include_path=true。

例如读取某个物品的真实核心行：

```json
{
  "view": "object",
  "table": "items",
  "target": {
    "kind": "ITEM",
    "id": "item_11111111-1111-4111-8111-000000000001"
  },
  "limit": 10
}
```

将以上 JSON URL 编码到 `/api/debug?input=...`。响应包含 table、columns、constraints、rows、total_count、next_cursor；下一页传 cursor。`view=system` 只能使用固定白名单表，可按支持的 id 或精确模板版本查询，没有任意 SQL 参数。每个分页请求各自保持一致快照，刷新时可回首页；浏览期间写入可能改变页边界。

直接在数据库容器中以只读事务核对（将示例 ID 替换为实际 ID）：

```sh
docker compose exec -T postgres psql -U acornary -d acornary -X -c "BEGIN READ ONLY; SELECT to_jsonb(i) FROM items i WHERE id='item_11111111-1111-4111-8111-000000000001'; COMMIT;"
```

输出与检查器核心行使用相同的 PostgreSQL JSON 序列化，不经过业务 DTO。Web 不提供 SQL 输入或数据库写入能力。

## 升级到内嵌属性（schema 003）

001 与 002 是保留的历史迁移；003 将独立绑定搬入核心行并删除旧表。版本感知脚本接受 schema 001、002 或 003 的非空备份，识别表结构、逐对象核对绑定内容和时间及全部辅助行。先备份并在独立数据库验证，再构建新镜像：

```sh
node scripts/local.mjs backup
node scripts/verify-id-migration.mjs .local/backups/<刚生成的备份目录>
docker compose build app
```

该脚本名称沿用此前 ID 迁移，但当前验证完整升级到 003。对 schema 002 副本，可额外传入保留的旧应用镜像，执行真实迁移前入库／消耗及迁移后重放检查；新增物品只存在于随后删除的独立副本：

```sh
node scripts/verify-id-migration.mjs .local/backups/<schema-002备份目录> acornary-before-embedded-attributes
```

正式升级前保留正在运行的旧镜像和配套备份。停止应用后生成最终备份，直至新版本启动前保持停写：

```sh
docker compose stop app
# 使用新的私有目录，目录权限 700、文件权限 600；下列固定目录应仅首次创建使用。
mkdir -m 700 .local/backups/pre-embedded
(umask 077; docker compose exec -T postgres pg_dump -U acornary -d acornary > .local/backups/pre-embedded/database.sql)
cp .env .local/backups/pre-embedded/app.env
cp .local/token .local/backups/pre-embedded/token
chmod 600 .local/backups/pre-embedded/*
docker compose up -d app
node scripts/local.mjs status
node scripts/verify-storage.mjs
```

启动迁移器在一个事务内聚合、核对绑定并删除 attribute_sets，只有迁移登记新增；对象原时间／revision、历史和幂等记录不变。003 不关闭事件追加保护。首次安装连续执行 001 至 003，重复启动和初始化不新增记录。业务 API 兼容，旧操作结果继续重放，legacy_v1 / unified_v1 指纹不变。

数据库只保证 attributes 非 null 且为数组；同家庭模板、版本、适用对象、唯一绑定和 values 由领域服务检查。直接 SQL 可绕过这些属性语义约束。检查器保留真实列值并去掉旧表查询。

迁移失败会回滚事务。回退需将备份恢复到独立数据库核对，并使用与备份 schema 匹配的旧镜像；不要让旧应用直接访问 003 schema，也不要覆盖正式库进行测试恢复。统一 ID 的历史规则仍见架构第 8 节及历史验证记录。
