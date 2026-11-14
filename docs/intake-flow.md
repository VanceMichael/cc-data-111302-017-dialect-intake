# 方言接收流程（src/intake）

面向“每日一份 CSV、但分隔符/引号/小数习惯不一致”的可负责接收流程。它不再靠几条猜分隔符的正则提前入库，而是把**候选、依据、确认、原始字节、规范记录与版本**串成一条可审计的链路。

## 承诺与边界

1. **有界抽样，多候选解释**：只读取前 64 KiB、至多 30 个完整行（`dialect.mjs` 常量可调）形成候选，整份文件不进内存。候选维度联合判定编码（BOM、严格 UTF-8、Latin-1 回退）、分隔符（`,` `;` 制表符 `|`）、引号、换行与金额格式（点号小数、逗号小数、弱证据推断）。
2. **列数稳定不等于通过**：每个候选还要过表头识别、必填字段与 decimal 类型校验。业务结果不同的候选产生不同解释指纹；存在两个及以上合法候选时进入人工确认，不自动通过。
3. **全量复核兜底**：自动或人工选定后，流式解析整份文件逐行复核。后续行推翻方言（如引号未闭合、类型不符）时**暂停整批**，记录冲突物理行与字节范围；已解释前缀只保留为临时（provisional）规范记录，不发布、不冒充完整交付。
4. **确认记录不可跨文件复用**：确认键由 `sha256(原始字节) + 解释指纹` 共同决定。同名但内容不同的文件哈希不同，无法套用旧确认；确认非法指纹会被拒绝。
5. **版本不可变**：发布物只追加（`published/`），修正选择后重新解释产生新版本并记录 `supersedes`，历史文件与旧规范记录保留，不静默改历史。

## 目录结构（运行状态默认在 `.local/intake`）

| 路径 | 内容 |
| --- | --- |
| `raw/<sha256>.bin` | 原始字节，内容寻址、流式哈希落盘，同名异文件各自独立 |
| `runs/<runId>.json` | 一次接收的完整记录：候选、证据、拒绝理由、状态机事件、冲突范围 |
| `confirmations/<key>.json` | 人工确认记录，绑定内容哈希与解释指纹 |
| `canonical/<sha256>-attempt<n>.jsonl` | 逐行规范记录，每轮尝试一个不可变文件 |
| `published/*.json` 与 `index.json` | 不可变发布版本与逻辑名当前版本指针 |

状态机：`probing → awaiting_confirmation | validating → accepted（发布）| blocked（暂停）| rejected（无成立候选）`。

## 命令行

```sh
npm run intake -- receive <文件> --name <逻辑名> [--state <目录>] [--schema <契约json>]
npm run intake -- confirm <runId> --fingerprint <指纹> --operator <人> --reason <说明>
npm run intake -- reinterpret <runId> --delimiter <,|;|\t|||> --operator <人>
npm run intake -- report <runId>
npm run intake -- runs | confirmations | published
npm run intake:demo   # 用 fixtures 中的 ambiguous/late/semicolon/utf16 跑通两条路径
```

`report` 输出资料员视图：当前方言及依据、被拒绝候选及理由、还缺哪些证据、冲突行与字节范围、确认记录与发布版本。

## 模块职责

- `encoding.mjs`：BOM/严格 UTF-8/Latin-1 判定与流式解码，多字节字符跨块由 `TextDecoder` stream 模式处理。
- `csv.mjs`：RFC4180 风格流式状态机，维护逻辑行、物理行与字节偏移，单字段 1 MiB 上限。
- `money.mjs`：金额格式候选与逐格解释，弱证据推断显式标注，所有尝试格式留痕。
- `schema.mjs`：契约加载、对齐表头识别、表头画像（错位切分兜底）、逐行类型校验。
- `dialect.mjs`：候选枚举、去重（同指纹双引号优先）、指纹与自动/人工裁决建议。
- `receive.mjs`：接收编排、全量复核、冲突暂停、确认、重解释、发布。
- `store.mjs`：内容寻址存储、确认键、不可变版本索引。
- `report.mjs`：Markdown/JSON 双视图。

## 与来源素材的对应关系

- `ambiguous`：逗号与分号均为合法但业务不同的候选 → 人工确认路径。
- `late`：前 30 行逗号方言稳定，第 31 行引号未闭合 → 全量复核拦截、整批暂停。
- `semicolon`：逗号小数与引号内分号，唯一合法候选 → 自动判别发布。
- `utf16`：BOM + CRLF + 逗号小数 → 编码/换行/金额联合自动判别。
