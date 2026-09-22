# Acornary / 松仓

**Acornary（松仓）** 是面向个人与家庭的物资管理与“物理世界记忆”系统。

它不只回答“我有什么”，还希望可靠地回答：

- 它是什么？
- 我有多少 / 具体是哪一个？
- 它在哪里？
- 它具有什么结构化特性？
- 它现在处于什么状态？
- 它经历过什么？
- 我关于它记录过什么文字、图片与故事？

核心定位：

> A structured memory for the physical things in your home.

## Design goals

1. **稳定核心，开放扩展**：新增食品、衣物、电子设备、工具、耗材等类别时，尽量不修改底层数据结构。
2. **正交建模**：分类、位置、属性、库存、状态、记忆、历史分别建模，不把不同语义都塞进同一层标签。
3. **AI-native but domain-controlled**：LLM / MCP 通过领域 API 操作物资，不直接写数据库。
4. **事实与推导分离**：例如保存 `expires_at`，而“即将过期”由规则实时推导。
5. **结构化事实 + 非结构化记忆**：Attributes 用于机器查询；Notes 用于用户自由记录文字、图片、做法与故事。

## Documentation

- [Documentation index](./docs/README.md)
- [Product language](./docs/product-language.md)
- [Domain model v1](./docs/domain-model.md)
- [Architecture v1](./docs/architecture.md)
- [Domain examples](./docs/examples.md)

核心模型可以概括为：

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

其中 Note / NoteAttachment 是正式的一等实体：结构化属性负责“事实”，Note 负责用户自己的做法、提醒、图片与故事。
