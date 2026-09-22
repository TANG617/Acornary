# Product language — Acornary / 松仓

## 1. Final naming

- **English product name:** Acornary
- **Chinese product name:** 松仓
- **Working description:** 家庭物资的结构化记忆
- **English positioning:** A structured memory for the physical things in your home.

“Acornary”延续松鼠收集、储藏并记住物品位置的意象；“松仓”强调家庭、储藏与记忆。中英文名称不要求逐字互译。

## 2. Product language vs domain language

品牌语言可以有松鼠意象，但核心代码与数据库必须保持中性、明确、可迁移。

| Product/UI concept | Suggested UI wording | Backend/domain name |
| --- | --- | --- |
| 家庭空间 | My Nest / 我的家 | `Household` |
| 所有物资 | Stash / 松仓 | `InventoryEntry` |
| 存放地点 | Places / 位置 | `Location` |
| 物品记忆 | Notes / Memories | `Note` |
| 变化记录 | History / 历史 | `InventoryEvent` |

不要在核心模型中使用 `Acorn`、`Nut`、`SquirrelItem` 等品牌化名称代替领域概念。

## 3. Product boundary

Acornary 不是单纯的 home inventory app，也不是仓储 ERP。其核心目标是建立一个可以被人和 AI 共同读写的家庭物理世界数据库：

- 我拥有什么？
- 它是什么？
- 有多少 / 具体是哪一个？
- 在哪里？
- 有什么结构化特征？
- 当前能否使用、状况如何？
- 什么时候过期？
- 经历过哪些变化？
- 我为它留下过哪些文字、图片、做法或故事？

因此产品应同时保留：

1. **Structured truth**：可查询、可比较、可计算的结构化事实。
2. **Human memory**：用户自由记录的文字和图片。

二者不能互相替代。
