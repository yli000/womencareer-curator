# Notion 审批

## 连接与审批位置

沿用网站现有 Notion 资源库，使用 `NOTION_TOKEN` 和 `NOTION_DATABASE_ID`。SDK 使用与网站一致的 `@notionhq/client` 2.3.0、`Notion-Version: 2022-06-28`。如果数据库迁移或版本变化使当前接口无法读取，停止并根据官方文档更新适配。

使用 API 辅助脚本时，由资源库所在工作区的所有者完成一次连接配置：

1. 在 Notion Developer portal 的 `Internal connections` 中创建给程序使用的连接，选择资源库所在工作区。已有专用连接可以继续使用。
2. 在 `Configuration` 中启用 `Read content`、`Insert content` 和 `Update content`，分别用于读取记录、创建草稿和更新草稿。
3. 打开 `Content access → Edit access`，仅选择目标资源库及其条目。
4. 由连接管理员在技能运行环境中配置 `NOTION_TOKEN` 和 `NOTION_DATABASE_ID`：前者为该连接的 token，后者为数据库本身的 ID。本地运行使用被 Git 忽略的 `.env`；定时任务使用调度平台的密钥设置。凭据不发送到聊天，不提交到仓库。

配置步骤依据 [Notion Internal connections 官方说明](https://developers.notion.com/guides/get-started/internal-connections)。下面的命令用于完成只读连接检查：

```sh
node --env-file=.env scripts/notion.mjs inspect
```

这项检查只读取字段、已发布/草稿数量和编号信息。`Published` 未勾选的页面都不会被网站当前同步脚本导出。可以在 Notion 手动创建“待审批”视图，筛选 `Published=false`；保持这个视图为团队内部使用。

使用已授权的 Notion 工具时，直接读取目标资源库确认访问权限和字段。读取失败时将连接检查结果保存在内部位置，继续整理可核实的草稿；连接恢复后读取当前审批状态。

条目的中英文介绍、分类、标签和链接填写在页面属性中；核实来源、核实日期与审批材料填写在页面正文。提交草稿时创建本技能审批区域，保留其他页面内容与人工留言。已有 `Published=true` 的条目按内容更新流程处理。

## 审批资料格式

AI 在 `work/` 使用文件编辑工具编写 JSON。结构如下，字段的实际值来自本次核实，不直接复制说明文字：

```json
{
  "schemaVersion": 1,
  "intake": {
    "kind": "recommendation",
    "receivedAt": "本次接收时间，ISO 8601，包含时区",
    "sourceRef": "不含私人联系方式的内部来源说明",
    "submissionId": "存在表单提交编号时填写"
  },
  "resource": {
    "id": "从网站与 Notion 查询得到的下一个编号",
    "slug": "resource-project-name",
    "name": "官方名称",
    "shortDescription": "根据官网编写的英文介绍",
    "shortDescriptionZh": "根据官网编写的中文介绍",
    "category": "Community",
    "tags": ["Career"],
    "tagsZh": ["职业发展"],
    "region": "Global",
    "type": "Professional Network",
    "typeZh": "职业网络",
    "language": ["English"],
    "cost": "Free",
    "status": "Active",
    "officialUrl": "实际核实的官网 URL",
    "featured": false
  },
  "verification": {
    "checkedAt": "本次核实时间，ISO 8601，包含时区",
    "relevance": "本次核实对象、适合的人群、职业发展用途及重要投入或限制",
    "evidence": [
      {
        "url": "实际阅读的官网页面 URL",
        "title": "页面标题",
        "checkedAt": "本次访问时间，ISO 8601，包含时区",
        "claims": ["name", "officialUrl", "shortDescription", "region", "language", "cost", "status"],
        "note": "来源性质、本次实际检查的内容、能够支持的事实和限制条件"
      }
    ],
    "unresolved": []
  }
}
```

`intake.kind` 支持 `discovery`、`recommendation`、`tally`、`api`。每条证据只填写该页面实际支持的字段；可以增加多条证据。另支持 `eligibility` 与 `deadline`。官网首页没有显示价格时，不为该页面标记 `cost` 已核实。

沿用现有字段记录面向使用者的判断：`verification.relevance` 说明本次核实对象、适合的人群、实际用途及重要投入或限制；`evidence[].note` 说明来源自述、独立佐证或编辑判断，以及本次实际检查的内容。按 [核实标准](intake.md#核实标准)选择相关项目，证据的 `claims` 对应最终介绍和参与条件支持的字段。脚本会把这些说明展示在 Notion 审批正文中。校验器检查格式、证据覆盖与日期，可信度和适用性由 AI 阅读来源并交由人工审阅。

`unresolved` 保存影响身份确认、参与条件或推荐依据的未知事项；已经确认的限制写入草稿，无需成为待确认事项。非空时保留在 `work/` 收集资料中，补充必要事实后才能提交审批。时间必须真实；所有核实证据在提交及发布时均需在七天以内。审批资料与抓取原文均被 Git 忽略。

## 提交草稿

```sh
node scripts/content.mjs validate --site SITE_REPO --candidate work/candidate.json
node --env-file=.env scripts/notion.mjs stage --site SITE_REPO --candidate work/candidate.json
```

脚本检查字段、网站重复及 Notion 全部记录的重复情况。草稿写入所有展示字段，`Published` 保持 false，正文保存核实依据与草稿内容校验值。返回的页面 URL 即人工审批位置。

脚本遇到已有同内容草稿会报告原页面，避免重复创建。超时或网络响应不明时，重新查询已有记录后继续；禁止直接重复创建。并行搜索可以独立执行，向 Notion 创建草稿使用单个串行任务。

## 人工决定

- 通过：人工阅读具体草稿与证据，勾选 `Published`。
- 需要补充：保持未勾选，在页面写明需要确认的内容。
- 不收录：保持未勾选，在页面写明决定；后续任务读取该决定，避免再次提交。

AI 不把建议收录解释为人工批准，不自行勾选 `Published`。Notion 的人工勾选是团队约定的批准方式；该脚本无法证明点击者身份，也无法阻止具有写权限的其他工具更改勾选状态。管理员应控制 Integration 权限和审批人员访问权限。

## 使用 Notion 连接工具

GPT 或其他 AI 已连接 Notion、但没有命令执行能力时，通过连接工具完成同一流程：

1. 读取用户指定的数据库及其 data source，确认字段类型和全部待查重记录；结果有分页时继续读取。
2. 按照字段映射创建页面，`Published=false`。正文包含可读的核实说明，并用 JSON code block 保存本次完整 `candidate`，标题使用“待审批草稿资料”。日期使用真实访问时间。
3. 返回页面链接，由人工核对具体内容后勾选 `Published`。
4. 发布时重新获取页面全部字段和正文。确认属于同一资源库、未被归档、`Published=true`，检查资料中的日期和证据；逐字段比较当前展示内容与 JSON 草稿。把 Notion rich_text 片段按顺序组合后比较文字，标签按集合比较。数字 ID 按至少三位的数字字符串比较；Featured 按 TRUE/FALSE 单选或 checkbox 转为布尔值。空的可选字段按未填写处理。
5. 任一字段发生变化时停止发布，重新核实并交由人工审批。全部一致时保存本次读取的页面 ID、最近修改时间及具体资源内容，在部署前再次读取并比较。

这条工具流程通过完整字段核对绑定审批内容。脚本流程另外要求本技能生成的元数据和内容校验值；不要声称手工创建的普通 Notion 页面已经通过脚本检查。不同执行环境接续任务时，先识别原草稿使用的流程，并完整读取它的核实材料。

## 修改草稿

人工修改展示字段后，需要再次核实对应内容。先由人工取消 `Published` 勾选，再由 AI 重新读取当前页面、更新资料，使用同一页面提交完整草稿：

```sh
node --env-file=.env scripts/notion.mjs stage --page-id NOTION_PAGE_ID --site SITE_REPO --candidate work/candidate-revised.json
```

保持该页面的 ID 和 slug，重新保存核实材料。更新完成后再次交由人工审批。已在网站发布的条目属于内容更新任务，需要保留其身份并核对现有内容；本技能默认的新资源检查会报告已有资源，随后使用已授权的 Notion 工具按同样审批规则处理具体更新。

## 读取批准结果

```sh
node --env-file=.env scripts/notion.mjs approved --page-id NOTION_PAGE_ID --output work/approved.json
```

只有同一数据库中的有效页面、人工勾选 `Published`、字段与核实草稿一致、证据在有效期内时，才会导出发布数据。导出文件包含资源、页面链接、Notion 最近修改时间和内容校验值。该时间用于追踪读取版本，不表示脚本能够确定勾选人的身份或准确点击时刻。

每次发布都重新读取结果；准备网站修改后、执行部署之前再读取一次，核对同一内容校验值。内容改变或审批撤销时，停止该资源的发布。网站当前没有与 Notion 联动的原子发布操作，检查与部署应连续执行。
