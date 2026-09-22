# Domain examples

这些例子检验 [领域模型](./domain-model.md) 与 [接口契约](./architecture.md) 是否一致，是契约样例，不等同于运行记录。Stage1 自动化与真实 Codex 的证据分别见 [验证记录](./stage1-verification.md)，可执行人工验收提示词见 [acceptance-prompt.txt](../scripts/acceptance-prompt.txt)。

Stage1 验证本机 Codex、明确 UUID 的库存操作、文字 Note 和只读 Web。下文标注“后续阶段”的自动选取、模板升级、图片附件与 OCR 不属于 Stage1；完整阶段边界见 Architecture。

示例 ID 均为完整实体前缀加标准 36 字符小写 UUID，表示系统已经生成的身份，不要求用户手写 ID。各场景独立；字段投影省略的系统时间、家庭或其他属性不表示持久化字段可以缺失。模板键及版本均来自领域模型的 v1 模板目录。

## 1. 六瓶相同牛奶：六个身份，共用一个商品定义

### 商品与空间

示例家庭为 household_99bfdd61-f0fe-5c44-a63b-6476819e0b8e，时区 Asia/Shanghai。已有 GROUP 分类树 `食品 → 乳制品 → 牛奶`，末级 GROUP ID 为 catalog_node_e45a9d60-6198-5a78-b79f-ed738af4d160。其下商品读取投影：

```json
{
  "id": "catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0",
  "household_id": "household_99bfdd61-f0fe-5c44-a63b-6476819e0b8e",
  "parent_id": "catalog_node_e45a9d60-6198-5a78-b79f-ed738af4d160",
  "kind": "SKU",
  "name": "蒙牛冷藏牛奶 1 L（示例规格）",
  "revision": 1,
  "attributes": [
    {
      "template_id": "product",
      "template_version": 1,
      "values": {
        "brand": "蒙牛",
        "specification": "1 L",
        "net_content": {
          "value": "1000",
          "unit": "mL"
        },
        "storage": {
          "requirement": "REFRIGERATED"
        }
      }
    }
  ]
}
```

业务响应 attributes 是对象内嵌绑定的读取投影，只保留模板键、版本和 values；数据库核心行还保存每个绑定的 created_at 和 updated_at。字段必须由模板声明。商品字段合在一个 product 绑定中；有经过确认的条码时用 update_attributes 设置 product 模板内的 barcodes，不覆盖 brand 等字段。SKU 中没有到期日或开封后保质期策略。

空间也是 Item：

| 显示名称 | UUID | parent_id |
| --- | --- | --- |
| 家 | `item_22222222-2222-4222-8222-000000000001` | null |
| 厨房 | `item_22222222-2222-4222-8222-000000000002` | 家的 UUID |
| 冰箱 | `item_22222222-2222-4222-8222-000000000003` | 厨房的 UUID |

这三个实例都引用本家庭隐藏的通用容器 SKU catalog_node_e2006356-b6dc-5c1f-b79c-774f229640da，并绑定 container v1，values 为 `{ "can_contain": true }`。隐藏 SKU 绑定 catalog v1，values 为 `{ "visibility": "HIDDEN" }`。命名变化不改变已经分配的目录 ID 或 Item UUID。

### 一次入库六件

用户已确认六瓶未开封、到期日相同；按包装标示估计每瓶剩余 1000 mL，并确认它们可用。本例不填写 lifecycle.state 或 expiry.date_kind，系统也不补默认值。调用 create_items：

```json
{
  "idempotency_key": "milk-receive-20260922-01",
  "catalog_node_id": "catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0",
  "parent_id": "item_22222222-2222-4222-8222-000000000003",
  "count": 6,
  "initial_attributes": [
    {
      "template_id": "lifecycle",
      "template_version": 1,
      "values": {
        "availability": "AVAILABLE",
        "opening": {
          "state": "SEALED"
        },
        "expiry": {
          "date": "2026-09-25"
        }
      }
    },
    {
      "template_id": "contents",
      "template_version": 1,
      "values": {
        "remaining": {
          "value": "1000",
          "unit": "mL"
        },
        "accuracy": "ESTIMATED"
      }
    }
  ]
}
```

同一事务建立下列六件，每件 revision=1，各有独立的 lifecycle 和 contents 绑定；不因共用 SKU 而共享可变属性：

| 简称 | Item UUID | catalog_node_id |
| --- | --- | --- |
| M1 | `item_11111111-1111-4111-8111-000000000001` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |
| M2 | `item_11111111-1111-4111-8111-000000000002` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |
| M3 | `item_11111111-1111-4111-8111-000000000003` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |
| M4 | `item_11111111-1111-4111-8111-000000000004` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |
| M5 | `item_11111111-1111-4111-8111-000000000005` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |
| M6 | `item_11111111-1111-4111-8111-000000000006` | `catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0` |

响应 affected_objects 包含这六个 UUID 及 before_revision=0、after_revision=1；六个 CREATE 事件共用 operation_id。重试相同请求必须返回相同的六个 UUID，不能再生成六件。

### “我开了一瓶”

Stage1 即使候选属性相同也不自动选择。Codex 先查询六件及其 revision，向用户展示可区分的候选，等待用户确认 M1，再调用 open_item；用户无需手写 UUID。

```json
{
  "idempotency_key": "milk-open-20260922-01",
  "expected_revisions": {
    "item_11111111-1111-4111-8111-000000000001": 1
  },
  "item_id": "item_11111111-1111-4111-8111-000000000001",
  "opened_at": "2026-09-22T08:00:00+08:00"
}
```

M1 的 lifecycle.opening.state 变为 OPENED，lifecycle.opening.opened_at 为请求时间，revision 变成 2；生成一个 OPEN 事件。expiry.date 和 availability 原值保留，lifecycle.state 仍缺省，其余五件不变。响应返回实际操作的 M1；UUID 及用户确认不能被描述为通过商品条码识别现场某瓶。请求不含 selection 或其他候选的版本。

### “刚开的那瓶喝掉了半瓶”

沿用前一步返回的 M1，基于已知包装规格将半瓶表达为估计 500 mL。调用 consume_item_content：

```json
{
  "idempotency_key": "milk-consume-20260922-01",
  "expected_revisions": {
    "item_11111111-1111-4111-8111-000000000001": 2
  },
  "item_id": "item_11111111-1111-4111-8111-000000000001",
  "amount": {
    "value": "500",
    "unit": "mL"
  },
  "accuracy": "ESTIMATED",
  "occurred_at": "2026-09-22T08:05:00+08:00"
}
```

本例原量和扣减都是估计，因此结果仍为 ESTIMATED。事件只记录实际改变的 remaining，不把不变的 accuracy 或 lifecycle 字段记作变化：

```json
{
  "id": "event_a3478a70-467b-50ba-b138-df4071a61c19",
  "household_id": "household_99bfdd61-f0fe-5c44-a63b-6476819e0b8e",
  "target_kind": "ITEM",
  "target_id": "item_11111111-1111-4111-8111-000000000001",
  "operation_id": "operation_5b3a0e12-79b8-5a38-a544-3f48cbb65bdd",
  "event_type": "CONSUME_CONTENT",
  "before_revision": 2,
  "after_revision": 3,
  "changes": [
    {
      "path": "attributes.contents.remaining",
      "template_id": "contents",
      "template_version": 1,
      "before_present": true,
      "after_present": true,
      "before": {
        "value": "1000",
        "unit": "mL"
      },
      "after": {
        "value": "500",
        "unit": "mL"
      }
    }
  ],
  "actor_id": "actor_02d985e4-6770-5cc8-b7c8-a8fc14b8fd9c",
  "source": "MCP",
  "occurred_at": "2026-09-22T08:05:00+08:00",
  "recorded_at": "2026-09-22T08:05:02+08:00"
}
```

此时六个 UUID 都保留，current_count=6、unknown_lifecycle_count=6；M1 是开封的半瓶，其余五瓶未开封。已知剩余内容合计估计 5500 mL，不能显示成“5.5 个实例”。明确过滤 lifecycle.state=ACTIVE 得到零件，因为没有这个已知事实；默认库存仍为六件。再喝完 M1 时，contents.remaining 归零与 lifecycle.state=CONSUMED 在同一事件和事务中提交，current_count 和 unknown_lifecycle_count 都变成 5，匹配历史记录仍有六件。

## 2. 最小记录、单字段补录与局部更新

本节为独立场景，沿用前文已有的 SKU 与冰箱作为引用。先创建一瓶只带核心关系的 Item，initial_attributes 完全省略：

```json
{
  "idempotency_key": "minimal-item-create-01",
  "catalog_node_id": "catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0",
  "parent_id": "item_22222222-2222-4222-8222-000000000003",
  "count": 1
}
```

系统返回 Q=`item_66666666-6666-4666-8666-000000000001`、revision=1。Q 的 attributes=[]，没有属性绑定，仍能查询、移动及按明确指令开封或整件消耗；仅计 Q 时，matching_count=1、current_count=1、unknown_lifecycle_count=1，不声称其已确认可用。

### 只知道到期日

调用 update_attributes，服务原子创建 lifecycle v1 绑定：

```json
{
  "target": {
    "kind": "ITEM",
    "id": "item_66666666-6666-4666-8666-000000000001"
  },
  "idempotency_key": "minimal-item-date-01",
  "expected_revisions": {
    "item_66666666-6666-4666-8666-000000000001": 1
  },
  "template_id": "lifecycle",
  "template_version": 1,
  "set": { "expiry.date": "2026-09-25" },
  "unset": []
}
```

Q.revision=2，values 只有 `{ "expiry": { "date": "2026-09-25" } }`；state、date_kind、opening 都缺省。一个 ATTRIBUTE_UPDATE 事件同时描述绑定从不存在到版本 1，以及日期路径从不存在到给定值；没有额外“填默认值”事件。

### 更新开封状态，保留已有日期

使用新的幂等键、expected_revisions 中 Q=2，调用同一 update_attributes，set 为 `{ "opening.state": "OPENED" }`、unset 为空。Q.revision=3，其完整 lifecycle.values 为：

```json
{
  "expiry": { "date": "2026-09-25" },
  "opening": { "state": "OPENED" }
}
```

事件变化项只覆盖新增的 opening.state；before_present=false，after_present=true，after="OPENED"。expiry.date 没有删除或变化，lifecycle.state 仍未知。开封时间未知时也不从系统记录时间补造。专用 open_item 对应同样的字段保留和校验规则，但事件意图为 OPEN。

随后用 Q=3、set 为空、unset 为 `["expiry.date"]` 清除日期，Q.revision=4，values 只剩 opening.state，空 expiry 对象被裁剪。再以 Q=4 显式清除 opening.state，则移除空绑定，Q.revision=5；单独 unset 一个已缺失但已声明的字段不创建绑定，不递增 revision 或新增事件。

### 没有 lifecycle 也能整件消耗

另有只带核心字段的 R=`item_66666666-6666-4666-8666-000000000002`、revision=1。调用 consume_items：

```json
{
  "idempotency_key": "minimal-item-consume-01",
  "expected_revisions": {
    "item_66666666-6666-4666-8666-000000000002": 1
  },
  "item_ids": ["item_66666666-6666-4666-8666-000000000002"]
}
```

R UUID 保留，revision=2，lifecycle.values 为 `{ "state": "CONSUMED" }`；没有内容计量事实，因此不造出 remaining 或单位。只生成一个 CONSUME_ITEMS 事件，包含绑定创建与 state 路径新增，并与快照同事务提交。仅计 Q 与 R，此时 matching_count=2、current_count=1、unknown_lifecycle_count=1。

对 R 普通 unset state、remove_attributes 移除 lifecycle 都必须拒绝；后续阶段的模板升级也不能丢掉 state 来绕过保护；若原记录有误，需通过带 reason 的 correct_item 修正。可选字段不能成为恢复终结库存资格的旁路。

## 3. 两次买鸡蛋：日期分组不是库存实体

本例按单个鸡蛋追踪，18 个 Item 都引用同一个本地鸡蛋 SKU catalog_node_152234f2-28f0-5227-ac2f-bee6c6d94872；每个实例在一个 lifecycle 绑定中明确记录 state=ACTIVE、availability=AVAILABLE。两次入库分别生成独立 UUID，在该绑定的 expiry、acquisition 下记录已知日期和来源。

| 查询分组 | 到期日 | batch_label | 匹配实例数 |
| --- | --- | --- | --- |
| 第一次购入 | 2026-09-25 | receipt-a | 6 |
| 第二次购入 | 2026-10-10 | receipt-b | 12 |

每行是查询汇总，不是一个持久化的数量记录。第一组实例包括 E1=`item_33333333-3333-4333-8333-000000000001`、E2=`item_33333333-3333-4333-8333-000000000002`。

### Stage1：用户确认具体两件

用户表示要使用两个鸡蛋时，Codex 查询实例与日期，展示候选并等待确认。用户明确选择 E1、E2 后，consume_items 提交以下请求，不按日期自行选择 UUID：

```json
{
  "idempotency_key": "eggs-consume-explicit-01",
  "expected_revisions": {
    "item_33333333-3333-4333-8333-000000000001": 1,
    "item_33333333-3333-4333-8333-000000000002": 1
  },
  "item_ids": [
    "item_33333333-3333-4333-8333-000000000001",
    "item_33333333-3333-4333-8333-000000000002"
  ]
}
```

两者各生成 CONSUME_ITEMS 事件，关联同一个 operation_id，生命周期变为 CONSUMED，UUID 留在历史中。查询 current_count 从 18 变成 16；第一次购入的 ACTIVE 分组从 6 变成 4。不存在对某个分组记录执行件数减二。

### 后续阶段：FEFO 自动选取

未来支持自动选取后，用户明确要求“优先用快到期的两个鸡蛋”，才可使用 selection.policy=FEFO、候选 UUID、count 及全部候选的 expected_revisions。此形式不进入 Stage1 工具 Schema，也不能由 Codex 在客户端自行模拟来替代确认。

若候选包含日期未知的第 19 件，后续 FEFO 请求返回 AMBIGUOUS_TARGET；用户可明确缩小到已知日期候选。不能将未知日期悄悄排到最后并声称已按所有库存的真实日期排序。

## 4. 移动行李箱：容器只有一个身份

| 简称 | UUID | SKU / 扩展 |
| --- | --- | --- |
| Bedroom | `item_44444444-4444-4444-8444-000000000001` | 通用容器 SKU，container.can_contain=true |
| Car | `item_44444444-4444-4444-8444-000000000002` | 通用容器 SKU，container.can_contain=true |
| Suitcase | `item_44444444-4444-4444-8444-000000000003` | 真实行李箱 SKU，container.can_contain=true |
| Pocket | `item_44444444-4444-4444-8444-000000000004` | 通用容器 SKU，container.can_contain=true |
| Cable | `item_44444444-4444-4444-8444-000000000005` | USB-C 线 SKU |

上表 container.can_contain=true 是 values.can_contain=true 的文字简写，不是额外字段。起始关系：

```text
Bedroom
└── Suitcase
    └── Pocket
        └── Cable
Car
```

调用 move_item（当前 Suitcase revision=1）：

```json
{
  "idempotency_key": "move-suitcase-01",
  "expected_revisions": {
    "item_44444444-4444-4444-8444-000000000003": 1
  },
  "item_id": "item_44444444-4444-4444-8444-000000000003",
  "parent_id": "item_44444444-4444-4444-8444-000000000002"
}
```

只修改 Suitcase.parent_id，revision 从 1 到 2，产生一个 MOVE 事件。Pocket、Cable 的 parent_id、revision 和历史均不变化；查询得到的新路径是 `Car → Suitcase → Pocket → Cable`。

将 Suitcase 移到 Pocket 下面形成环，必须拒绝；将 Cable 当成容器也必须拒绝。仍有 Pocket 时，不能移除 Suitcase 的容器能力，也不能直接删除它。

## 5. 洗衣液余量：修正精度，身份不变

洗衣液瓶 UUID 为 `item_55555555-5555-4555-8555-000000000001`，revision=4，生命周期 ACTIVE，contents v1 当前为：

```json
{
  "remaining": {
    "value": "40",
    "unit": "percent"
  },
  "accuracy": "ESTIMATED"
}
```

后来实测剩余 800 mL。调用 correct_item：

```json
{
  "idempotency_key": "detergent-measurement-01",
  "expected_revisions": {
    "item_55555555-5555-4555-8555-000000000001": 4
  },
  "item_id": "item_55555555-5555-4555-8555-000000000001",
  "reason": "重新测量剩余体积为 800 mL，替换此前的估计比例",
  "attributes": [
    {
      "template_id": "contents",
      "template_version": 1,
      "set": {
        "remaining": {
          "value": "800",
          "unit": "mL"
        },
        "accuracy": "MEASURED"
      },
      "unset": []
    }
  ]
}
```

原 UUID 不变，revision=5，生成一个包含 contents.remaining 与 contents.accuracy 两个变化路径及前后值的 CORRECT 事件，其他模板不受影响。这里是新测量事实，不是从 40% 自动推算 800 mL，也不会创建第二瓶洗衣液。

## 6. 改名、改条码、移动分类

对牛奶 SKU catalog_node_5fca2e56-8771-5634-8406-49ee748f6ef0 分别使用 update_catalog_node 修改名称、update_attributes 在 product 模板内设置 barcodes、move_catalog_node 改到另一个 GROUP 下。设置 barcodes 不覆盖 net_content、brand 或 storage.requirement。

三次成功操作各递增该 CatalogNode revision 并生成 Event；SKU ID 和所有 Item.catalog_node_id 都不改变。六瓶牛奶的日期、余量、开封情况和 revision 不受影响。读取时显示的新商品名是解析当前关联得到的展示结果，不是六个实例被重写。

若新条码已属于另一个 SKU，返回 BARCODE_CONFLICT；若识别出实际是另一个商品规格，创建不同 SKU，明确纠正误关联实例，不能用覆盖一个 SKU 的方式把两种产品混为一谈。

## 7. 饺子、衣物、电子物品与记忆

| 场景 | 商品定义 | 独立实例及模板 |
| --- | --- | --- |
| 一袋饺子剩 60% | SKU 的 product.net_content 描述净含量 | 一个 UUID；contents.remaining 为 60 percent，contents.accuracy 为 ESTIMATED，lifecycle.expiry.date 保存该袋日期 |
| 黑色羊毛帽 | SKU 的 clothing 描述 material、color | 一个 UUID；lifecycle.state、lifecycle.condition 描述状态；Note 保存购买故事 |
| 大衣磨损且送洗 | SKU 的 clothing 描述衣物信息 | 一个 UUID；一个 lifecycle 绑定中记录 state=ACTIVE、condition=WORN、availability=CLEANING |
| 三根同款 USB-C 线 | 共用一个 SKU，device 为 connector=USB-C、rated_power_w="100" | 三个不同 UUID，分别放在书桌、办公室、行李箱；位置和状态各自更新 |

例如给饺子袋添加 Note：“水开后下锅，再次沸腾加冷水，共两次；上次煮太久有一点软。”Stage1 文字使用 Markdown。add_note 更新这袋饺子的记忆和 revision，记录 NOTE_CREATE；update_note 修改正文时同样记录该 Item 的事件和 revision，Web 安全渲染正文并展示历史。后续图片完成关联时才记录 ATTACHMENT_ADD。

Note 中出现“还剩一半”不自动覆盖 contents。用户明确要求修改余量后，才通过模板或纠错命令写入事实。后续 OCR 识别结果同样先作为候选，不覆盖原图与原始笔记。

## 8. 查询和错误行为

“我能做番茄炒蛋吗”先查询：已知可用鸡蛋有 3 件、已知可用番茄内容合计 450 g。对照食谱所需 3 件和 300 g，可以给出基于已知库存的建议；用户明确表示用了以后再执行消耗。若只有“两个番茄”而无重量，不能推断足够 300 g。

以下是未来运行时验收输入与期望，不是当前已有测试。除明确标注“后续阶段”的能力外，均作为 Stage1 领域约束验收：

| 输入或冲突 | 必须观察到的结果 |
| --- | --- |
| 同键重试六瓶入库 | 原来的六个 UUID、原操作结果；没有第七件或重复 CREATE |
| 同键换成七瓶 | IDEMPOTENCY_CONFLICT，无新实例 |
| 两个请求都用 revision=2 消耗同一瓶 | 至多一个成功，另一方 REVISION_CONFLICT，不丢失更新 |
| 两件消费，其中一件已被别人消费 | 整个命令回滚，另一件不发生局部变化 |
| 只给核心字段创建 Item | 不创建默认属性；可查询和明确操作，current_count 与 unknown_lifecycle_count 均包含该件 |
| 仅填写 expiry.date，未填 date_kind 或 state | 合法；不补默认值，可查询该日期，生命周期状态仍未知 |
| 仅填写 expiry.after_opening_days，未填 opened_at 或 date | 合法；不生成确定的开封后提醒日期 |
| 只填写 opening.opened_at | 可推导已开封，不要求同时持久化 opening.state；重复 open_item 不刷新时间 |
| 同时提交 SEALED 与 opened_at | ATTRIBUTE_VALIDATION_FAILED，矛盾事实不落库 |
| 对已有 expiry.date 的 lifecycle 只 set opening.state | 日期保留；Event 只记录实际变化，不把未提及字段记成删除 |
| 同次 set / unset 同一路径、父子路径重叠，或使用未知路径 | ATTRIBUTE_VALIDATION_FAILED；没有部分更新 |
| Measurement 缺 unit，或只 set remaining.value | ATTRIBUTE_VALIDATION_FAILED；remaining 按 value + unit 整体更新 |
| 扣减未填写 accuracy | 不要求补精度；结果 accuracy 缺省，不继承原有 MEASURED 标签；事件记录必要的精度字段清除 |
| 仅 unset 不存在但已声明的字段 | changed=false，不创建空绑定、revision 或事件 |
| 清空普通模板最后一个字段 | 裁剪空对象并移除绑定，原子记录实际移除；仍检查领域约束 |
| 对已知 CONSUMED 的 Item 普通 unset state、移除 lifecycle；后续阶段升级时漏掉 state 同样禁止 | INVALID_TRANSITION，不能恢复库存资格；纠错必须使用 correct_item 并给 reason |
| 将内容量设成负数、percent=120，或附加未定义的自由字段 | ATTRIBUTE_VALIDATION_FAILED；专用命令和模板命令均不能绕过 |
| 对未绑定 contents 或仅有 accuracy 的对象减去 200 mL | MISSING_FACTS，指出 contents.remaining 及用途，不从 SKU 净含量猜测当前剩余量 |
| 容器挂到自身后代；两个并发移动共同形成环 | CYCLE_DETECTED；并发时序也不能提交环 |
| 引用另一个家庭的 SKU、父节点或模板；后续阶段亦包括附件 | 拒绝且不泄露对方对象内容 |
| 移除仍有子节点的 container.can_contain | TEMPLATE_IN_USE；树保持合法 |
| 后续阶段：用过时 expected_revisions 升级模板 | REVISION_CONFLICT，绑定仍指向原版本 |
| 后续阶段：尝试通过模板发布接口原地更改已发布字段 | 拒绝；发布新版本并显式升级后，事件保留前后版本和值 |
| 重复打开已经 OPENED 的同一瓶 | 合法无变化不新增事件、不刷新 opened_at；改错走 CORRECT |
| 时间从到期日跨到次日 | 查询推导变化，实例 revision 和 Event 数量不变化 |
| 属性未知、日期未知、比例无法换算 | 返回未知与缺失范围，不静默当作可用或精确总量 |

文档静态验收需要检查六个牛奶 UUID 唯一、JSON 有效、七个模板的名称／版本／嵌套字段及更新路径一致、操作与事件对应、图中关系与字段表一致、链接有效。目录和物品相关字段、操作、事件只使用 CatalogNode / Item 命名；同时检查核心字段创建、单日期绑定及 set / unset 示例。数据库原子性、并发、权限与 MCP 互通只能由后续实现测试证明。


## 9. Stage1 本地闭环验收

以下验收须由未来实现后的真实本机 Codex、PostgreSQL 和浏览器共同完成；文档落盘不代表通过。

| 场景 | 验收要求 |
| --- | --- |
| 初始化与连接 | 本机 Compose 启动应用和 PostgreSQL，初始化 Household、七个模板及隐藏容器 SKU；重复执行不重复创建、不改变身份；Codex 使用个人凭证连接 /mcp |
| 六瓶奶与只读 GUI | 六个 UUID 共用同一 SKU；双树可跳转；按确认的 M1 开封和部分消耗，其余五件不变；页面刷新后可核对属性、revision 和事件 |
| 容器移动 | 只改容器父引用，后代路径变化，后代无虚假移动事件 |
| 文字记忆 | Codex 创建及修改 Note；Web 展示正文与历史，Markdown 不执行原始 HTML |
| 查询与未知值 | 名称、条码、子树及属性过滤可用；件数、未知生命周期数量和剩余量分别展示；缺失字段显示“未记录” |
| 幂等与约束 | 重试无重复对象／消耗；版本、非法属性、循环、跨家庭及并发冲突被拒绝；失败批量操作全部回滚 |
| 明确实例边界 | 多候选先确认，服务不自动选择；Stage1 Schema 没有 selection / EQUIVALENT / FEFO，也不注册模板升级及附件工具 |
| 只读与凭证 | Web 只读 API 无法执行写入；无有效凭证的 MCP 写入被拒绝；浏览器不获得 MCP 写凭证 |
| 浏览与刷新 | 展开、搜索、过滤、跳转、复制 UUID、数据库记录、派生结果与 API 响应 和手动刷新可用；重新聚焦刷新，打开期间每 5 秒更新当前视图；无编辑、拖拽移动或上传入口 |
| 持久化与恢复 | 服务停止、重启后数据保留；完成一次 PostgreSQL 备份恢复，核对实例身份、模板值、文字笔记和事件 |

领域使用 Vitest，事务与并发使用真实 PostgreSQL，只读浏览流程使用 Playwright；真实 Codex 的连接、澄清与读写闭环单独记录结果。ChatGPT、OAuth、图片附件、模板升级与后台任务不纳入 Stage1 验收。


## 数据库内嵌属性与业务投影

以下为 items.attributes 列的完整 JSONB 示例；所属 Item、家庭和父引用位于外层核心行，不在绑定中重复保存。template_id 排序仅用于稳定持久化，不表示优先级。

```json
[
  {
    "template_id": "contents",
    "template_version": 1,
    "values": {"remaining": {"value": "800", "unit": "mL"}},
    "created_at": "2026-09-22T10:26:42.275723+00:00",
    "updated_at": "2026-09-22T11:30:00.123456+00:00"
  },
  {
    "template_id": "lifecycle",
    "template_version": 1,
    "values": {"opening": {"state": "OPENED"}},
    "created_at": "2026-09-22T11:00:00.123456+00:00",
    "updated_at": "2026-09-22T11:00:00.123456+00:00"
  }
]
```

get_item 和 get_attribute_sets 保持原接口，每个绑定只返回 template_id、template_version、values。只修改 contents.remaining 时，lifecycle 的值与时间不变；重复设置相同值不递增 Item revision，不修改任何时间，不产生事件。清空 contents 最后字段后移除该成员，再绑定时使用新创建时间。直接 SQL 能写入数组中的非法业务值，只有领域服务保证模板、家庭、版本、唯一性与值校验。
