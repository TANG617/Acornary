# Acornary / 松仓

**Acornary（松仓）** 是面向个人与家庭的物资管理与“物理世界记忆”系统。

> A structured memory for the physical things in your home.

它希望可靠地回答：物品是什么、具体拥有哪几件、在哪里、剩余多少、现在怎样、经历过什么，以及用户为它记录的文字、图片与故事。

## 当前状态

Stage1 运行代码、数据库迁移、MCP 服务、只读 GUI 与自动化测试已落地。本地已有库存；当前属性直接内嵌到物品和目录行，核心模型为三张表，整个数据库共十一张表；开发者检查器忠实展示 PostgreSQL 行。真实 Codex 的完整 Stage1 验收与本轮自动化验证分别记录。实际证据见 [验证记录](./docs/stage1-verification.md)。

**Stage1：本地库存操作与只读模型检查器。** 应用、PostgreSQL、Codex 和浏览器在同一电脑运行；通过 Codex 操作明确 UUID 的库存与文字笔记，Web 只读展示两棵树及 11 张表的实际记录，分开呈现派生结果和 API 响应。自动选取与 FEFO、图片附件、模板升级、云托管、ChatGPT、HTTPS、OAuth、注册登录及后台任务后置。

Stage1 沿用 TypeScript / Node.js 24 LTS、Fastify 5、官方 MCP TypeScript SDK v2、PostgreSQL 18、Drizzle、Zod 4、React / Vite；Docker Compose 运行应用与数据库，端口仅绑定本机，MCP 使用本地个人访问凭证。长期保留云托管方向与 Better Auth / Caddy 选型。完整边界见 [架构与 Stage1 范围](./docs/architecture.md)。锁定依赖、启动、连接、备份和测试命令见 [本地运行](./docs/local-runtime.md)。

## 本地启动

```sh
node scripts/local.mjs init
node scripts/local.mjs codex
```

Web：<http://127.0.0.1:3210>。Docker 内使用 Node 24，无需切换宿主机 Node。

## 核心模型

```text
CatalogNode（含 attributes） ──定义──> Item（含 attributes）
          │                            │
          └── 按模板键和版本校验 ────────┤
                   AttributeTemplate   └── Note → NoteAttachment（后续）

CatalogNode / Item 的变化 → Event
```

核心三张表为 catalog_nodes、items、attribute_templates。属性绑定是对象 attributes 数组中的值结构，无独立表或 ID；家庭、操作者、笔记、事件、幂等及其他支撑表继续保留。

- **CatalogNode**：GROUP 组织分类，SKU 描述具体商品；系统生成的稳定 ID 不随名称、条码或分类改变。
- **Item**：每件实物一个 UUID；六瓶同款牛奶共用一个 SKU，但拥有六个不同 UUID。空间与容器也是 Item，其父引用表达实际放置关系。
- **受控模板**：product、lifecycle、contents、container、catalog、clothing、device 七个模板覆盖属性扩展；业务字段默认可选，二级／三级路径受定义约束，禁止任意 KV。
- **Event**：当前状态与追加式事件原子更新，解释每次实际变化；数量汇总和完整位置路径由查询推导。
- **Note / NoteAttachment**：保存用户自由记录的做法、提醒、文字、图片与故事。

## Design goals

1. **稳定身份**：开封、部分消耗、移动、纠错均保留实物 UUID；件数来自实例统计。
2. **明确关系**：分类树回答“是什么”，容纳树回答“在哪里”；容器只用一个实例表达。
3. **最小核心、受控扩展**：新增物品类别优先使用模板；模板版本固定，升级显式执行；set / unset 只修改指定属性路径。
4. **AI-native、领域服务控制**：共享领域服务维护权限、模板校验、幂等与事务；Stage1 MCP 负责业务写入，Web 只读，不让模型直接写数据库。
5. **事实与推导分离**：保存实例上的日期与开封事实，临期、路径和分组统计按需计算；未知状态可参与日常库存和明确操作，不自动补成 ACTIVE 或已确认可用。
6. **结构化事实与自由记忆并存**：属性可查询、可比较；笔记保留用户表达，不自动覆盖结构化事实。

## Documentation

- [本地运行与备份](./docs/local-runtime.md)
- [实际验证记录](./docs/stage1-verification.md)
- [文档索引](./docs/README.md)
- [领域模型与静态结构](./docs/domain-model.md)
- [架构与公共接口](./docs/architecture.md)
- [场景示例与验收要求](./docs/examples.md)
- [产品术语](./docs/product-language.md)
