# Acornary documentation

本目录记录 Acornary / 松仓 v1 的产品与工程基线。

## Documents

- [Product language](./product-language.md) — 品牌命名、产品概念与工程命名边界
- [Domain model](./domain-model.md) — 最终选定的 ontology、实体、字段、状态与不变量
- [Architecture](./architecture.md) — App / API / MCP / 数据库 / 对象存储 / Worker 架构
- [Examples](./examples.md) — 食品、衣物、电子物品、容器、Note 与 AI 操作的完整示例

## One-sentence model

Acornary 把家庭中的物理物资表示为：

```text
Item
= Identity
+ Inventory
+ Location
+ Attributes
+ State
+ Memory
+ History
```

其中：

- **Identity** → Category + ItemType
- **Inventory** → InventoryEntry + quantity / unit / tracking mode
- **Location** → Location tree
- **Attributes** → schema-defined structured properties
- **State** → lifecycle + condition + availability
- **Memory** → Note + image attachments
- **History** → InventoryEvent

这套模型的目标是：新增物资类别时主要扩展 taxonomy、attribute schema 与 policy，而不是频繁修改核心数据库结构。
