# 网站字段与编辑

适配依据：网站 `data/resources.ts`、`scripts/sync-notion-resources.mjs`、资源卡片及分类配置。每次发布以目标仓库当前代码为准；字段不兼容时更新适配并验证后继续。

## 分类

| Category | 网站中文名称 | 收录内容 |
|---|---|---|
| Community | 社群 | 职业组织、专业网络、互助社群 |
| Learning | 学习 | 课程、学习平台、培训资料 |
| Book | 书籍 | 有明确职业发展用途的书籍 |
| Scholarship | 奖学金 | 学习或参与活动的资助 |
| Fellowship | 奖助项目 | 有结构化培养安排的项目 |
| Mentorship | 导师制 | 导师匹配、指导计划 |
| Conference | 会议 | 会议、行业活动 |
| Tool | 工具 | 求职、职业规划、生产力工具 |
| Podcast | 播客 | 音频节目 |
| Newsletter | 通讯 | 定期发布的通讯 |
| Research | 研究 | 研究报告、数据资料 |
| Open Source | 开源 | 开源项目与开放协作资源 |

## 字段映射

| Resource | Notion property | 类型与要求 |
|---|---|---|
| id | ID | 按数据库 schema 使用 number 或 rich_text；资源中的编号为数字字符串，number 转换时至少三位，例如 97 对应 "097" |
| slug | Slug | rich_text；唯一英文小写名称，使用连字符 |
| name | Name | title；官方名称 |
| nameZh | Name ZH | rich_text；有可靠中文名称时填写，品牌名可以保留原文 |
| shortDescription | Short Description | rich_text；简洁英文介绍 |
| shortDescriptionZh | Short Description ZH | rich_text；中文介绍 |
| category | Category | select；上述十二个英文值之一 |
| tags | Tags | multi_select；优先复用现有英文标签 |
| tagsZh | Tags ZH | multi_select；中文标签，术语可以保留英文 |
| region | Region | select；现有值含 Global、China、Asia、Europe、North America |
| type | Type | rich_text；具体英文资源类型 |
| typeZh | Type ZH | rich_text；中文资源类型 |
| language | Language | multi_select；现有值含 English、Chinese、Multiple |
| cost | Cost | select；Free、Paid、Mixed |
| status | Status | select；Active、Archived |
| officialUrl | Official URL | url；具体资源官方页面 |
| logoUrl | Logo URL | url；有适合公开展示的可靠链接时填写 |
| featured | Featured | 按数据库 schema 使用 select（TRUE/FALSE）或 checkbox；新资源对应 FALSE 或 false |
| 发布开关 | Published | checkbox；草稿 false，人工批准时 true |

`Name ZH` 与 `Logo URL` 可以留空；候选没有相应内容时，数据库也可以没有这两个可选字段。技能提交的新草稿需要中文介绍、中文类型和中文标签。必要字段缺失，或候选具有可选内容但数据库缺少对应字段时，停止提交并明确需要哪些字段；未经用户授权不修改现有数据库结构。

脚本连接数据库后读取实际 schema，再决定写入格式。`Featured` 单选写入复用数据库中已有的 TRUE/FALSE 选项，允许大小写差异；所需选项缺失、存在重复含义或页面值为空时停止并说明字段情况。

新增 ID 取网站与 Notion 全部记录的最大数字编号加一，包括未批准的草稿；提交前再次检查唯一性。同一资源后续修改保留 ID 与 slug。Notion 提交必须串行执行；平台没有提供跨进程的原子编号预留，不同时运行多个写入任务。

已有网站记录与 Notion 编号可能存在不同对应关系；按 slug、官网与名称确认资源身份，并分别保留两边已有编号。新增候选写入 number 字段时使用至少三位的规范编号，保证写入后重新读取的内容校验值一致。

## 介绍文案

说明提供什么、适合谁、如何使用或参与。英文通常一个简洁句子；中文使用完整自然的句子，根据重要条件决定长度。网站使用普通文本呈现，不填写 Markdown 标题、表格、HTML 或依赖格式渲染的列表。

让接受资源的人能够判断是否值得投入：按资源的实际要求说明基础、语言、时间、免费范围、收费部分及参与条件，优先保留会影响选择的信息。面向广泛用户时写明适用群体，针对个人推荐时结合其已表达的需求。介绍只覆盖本次核实对象；课程样本、公开回放、平台和具体付费服务分别描述。

品牌与代码 identifier 保留官方写法。中文名称不得暗示未经确认的官方译名。避免无依据的效果承诺、排名、规模数字和宣传形容词。截止日期、资格或费用影响使用决策时，保留已经核实的限制条件。

把来源声称的效果与能够确认的内容分别表达。获得结课证书、证书认可和就业结果各自需要相应依据。推荐理由说明资源怎样支持学习或职业目标；核实结论标明具体范围，不承诺所有人都能取得同样结果。

`Free` 需要核心资源免费且不存在必需付款的证据；`Paid` 表示使用核心资源需要付费；`Mixed` 表示官网明确提供免费与付费部分。“官网未显示价格”需要补充核实。奖学金发放资助与申请过程是否收费分别核实。

网站 Resource 没有核实日期、审批人、截止日期或推荐者邮箱字段。证据和审批资料放在 Notion 页面正文；必要的申请期限写入中英文介绍。

## 提交前检查

```sh
node scripts/content.mjs inspect --site SITE_REPO
node scripts/content.mjs validate --site SITE_REPO --candidate work/candidate.json
```

`inspect` 读取真实资源，提供已有分类、地区、语言、标签和网站下一个编号。最终编号还需要参考 `notion.mjs inspect` 的全部草稿。校验器检查字段、重复资源、中文内容、证据覆盖及时间，事实是否成立仍由 AI 阅读来源并由人工审批。
