# Domain examples

这些例子用于压力测试 Acornary v1 模型。只要这些跨领域场景都能自然表达，新增大多数家庭物资就不应要求修改核心 schema。

---

## 1. Food — 两批鸡蛋 + FEFO

### ItemType

```json
{
  "name": "鸡蛋",
  "category": "Food > Egg",
  "default_tracking_mode": "QUANTITY",
  "default_unit": "count",
  "default_attributes": {
    "storage_requirement": "refrigerated"
  }
}
```

### Inventory entries

```json
[
  {
    "id": "egg-lot-a",
    "quantity": 6,
    "initial_quantity": 12,
    "unit": "count",
    "location": "Home > Kitchen > Refrigerator > Door",
    "expires_at": "2026-09-25",
    "lifecycle_status": "ACTIVE"
  },
  {
    "id": "egg-lot-b",
    "quantity": 12,
    "initial_quantity": 12,
    "unit": "count",
    "location": "Home > Kitchen > Refrigerator > Door",
    "expires_at": "2026-10-10",
    "lifecycle_status": "ACTIVE"
  }
]
```

用户说：

> 我用了两个鸡蛋。

系统按 FEFO 选择 `egg-lot-a`：

```text
egg-lot-a.quantity: 6 -> 4
```

同时记录：

```json
{
  "event_type": "CONSUME",
  "inventory_entry_id": "egg-lot-a",
  "quantity_delta": -2,
  "source": "VOICE_ASSISTANT"
}
```

---

## 2. Food — 一袋饺子 + 用户自己的做法和图片

### ItemType

```text
Category:
Food > Frozen Food > Dumpling

ItemType:
湾仔码头 猪肉白菜水饺 720g
```

### InventoryEntry

```json
{
  "tracking_mode": "QUANTITY",
  "initial_quantity": 100,
  "quantity": 60,
  "unit": "percent",
  "location": "Home > Kitchen > Freezer > Drawer 2",
  "expires_at": "2026-09-28",
  "lifecycle_status": "ACTIVE"
}
```

### Note

```markdown
### 我喜欢的煮法

水开以后下锅。再次沸腾后加冷水，共加两次。
总时间大约 8 分钟。

上次煮到 10 分钟感觉有一点软。
```

Note 可以附：

- 包装正面照片
- 背面的官方烹饪说明照片
- 自己煮好的成品照片

这些图片进入 Object Storage，并通过 NoteAttachment 关联。

这里“做法”是用户经验，不需要为了它新增 `cooking_instruction_1`、`cooking_instruction_2` 等结构化字段。

---

## 3. Apparel — 一顶帽子的属性与故事

### ItemType / attributes

```json
{
  "name": "黑色羊毛帽",
  "category": "Apparel > Hat",
  "default_tracking_mode": "UNIQUE",
  "default_attributes": {
    "color": "black",
    "material": "wool",
    "warmth": 4,
    "season": ["autumn", "winter"]
  }
}
```

### InventoryEntry

```json
{
  "tracking_mode": "UNIQUE",
  "location": "Home > Bedroom > Wardrobe > Top Shelf",
  "lifecycle_status": "ACTIVE",
  "condition": "GOOD",
  "availability": "AVAILABLE"
}
```

### Note

```markdown
这顶帽子是在北海道旅行时买的。
下雪那天第一次戴，之后一直留着。
```

再附一张旅行照片。

这个故事应该留在 Note，不应该变成 Attribute。

---

## 4. Apparel — “磨损”和“干洗”不是同一个 status

一件大衣：

```text
lifecycle_status = ACTIVE
condition        = WORN
availability     = CLEANING
```

这样可以准确表达：

> 这件衣服仍然属于我，已经有磨损，现在送去干洗，所以暂时不可用。

如果只使用一个 `status`，系统将被迫在 `WORN` 和 `CLEANING` 之间二选一。

---

## 5. Electronics — 三根相同型号的数据线

### ItemType

```json
{
  "name": "USB-C to USB-C Cable 2m",
  "category": "Electronics > Cable",
  "default_tracking_mode": "UNIQUE",
  "default_attributes": {
    "connector_a": "USB-C",
    "connector_b": "USB-C",
    "length_m": 2,
    "max_power_w": 100
  }
}
```

### Entries

```text
Cable #1 -> Home > Bedroom > Desk > Drawer
Cable #2 -> Office > Desk
Cable #3 -> Black Suitcase > Inner Pocket
```

ItemType 复用共同信息；每根线作为独立 InventoryEntry 维护自己的位置、condition、availability 和历史。

因此可以可靠回答：

> 我那根放旅行箱里的 100W USB-C 线在哪？

---

## 6. Container — 行李箱既是物品，也是位置

### InventoryEntry

```text
Black Suitcase
Category = Travel > Luggage
tracking_mode = UNIQUE
```

### Linked Location

```text
Home
└── Bedroom
    └── Black Suitcase
        └── Inner Pocket
            └── USB-C Cable #3
```

`Black Suitcase` 对应的 Location 通过 `linked_inventory_entry_id` 指向行李箱 entry。

将行李箱从 Bedroom 移到 Car 时，内部物品仍然保持：

```text
Black Suitcase > Inner Pocket
```

这一相对结构。

---

## 7. Household supplies — 洗衣液只知道大概剩余比例

如果无法可靠记录 ml：

```json
{
  "name": "洗衣液",
  "tracking_mode": "QUANTITY",
  "initial_quantity": 100,
  "quantity": 40,
  "unit": "percent"
}
```

如果以后通过称重或包装规格知道实际容量，可以建立新的 entry 使用：

```text
initial_quantity = 2000 ml
quantity         = 800 ml
```

核心 schema 不需要变化。

---

## 8. Recipe intent — 番茄炒蛋

用户说：

> 我想吃番茄炒蛋。

Recipe / Agent layer 将需求表示为：

```text
Tomato: 300 g
Egg:    3 count
```

Acornary 返回：

```text
Tomato:
  450 g
  Refrigerator

Egg:
  Lot A: 2 count, expires first
  Lot B: 8 count
```

Agent 可以判断总量足够，并提示优先使用快过期的 Lot A。

如果用户随后说：

> 好，我用了三个鸡蛋和大概 300 克番茄。

Agent 分别调用领域工具执行消费。Recipe 推理与库存变更保持解耦。

---

## 9. Note search — “我之前觉得最好吃的饺子”

用户问：

> 我之前觉得比较好吃的饺子是哪一袋？

Inventory 的结构化字段未必包含“好吃”。

但某条 Note 可能是：

```text
这款上次感觉最好吃，可以再买。
```

未来搜索层可以组合：

```text
Category = Dumpling
+
Note full-text / semantic search
```

返回对应 ItemType / InventoryEntry。

重要原则：AI 可以理解 Note，但不应偷偷把用户的原始 Note 改写为结构化事实。

---

## 10. Why these examples matter

这组例子故意覆盖：

- quantity stock
- unique objects
- multiple lots
- expiry
- FEFO
- percentage approximation
- category-specific attributes
- independent state dimensions
- nested location
- item-as-container
- text notes
- image notes
- voice / MCP writes
- AI semantic reads

如果新增一个普通家庭物资需要修改核心 ontology，应先检查它是否其实可以通过 Category、AttributeDefinition、ItemType policy、Note 或 Event metadata 表达。
