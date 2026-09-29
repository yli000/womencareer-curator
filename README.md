# 巫门资源编辑技能包

适用于 GPT、Codex、Claude 及能够读取仓库文件、访问网页和操作已授权服务的 AI。技能入口是 [SKILL.md](SKILL.md)。

支持搜索发现资源、抓取网页或 API、接收朋友推荐和 Tally 表单资料；统一核实后写入现有 Notion 资源库供人工审批；审批通过后按照网站格式更新并发布内容。

核实从接受资源的人的用途出发：公开学习材料重点检查内容、免费范围和适用人群；付款、人员互动、提交资料或现场参与时增加对应检查。介绍说明实际用途、投入和限制，具体规则见 [核实标准](references/intake.md#核实标准)。

## 通过对话使用

仓库地址：[yli000/womencareer-curator](https://github.com/yli000/womencareer-curator)。把仓库地址和任务一起发给 AI。例如：

> 请读取 https://github.com/yli000/womencareer-curator 的 README.md 和 SKILL.md，按照技能查找适合巫门网站的女性职业资源。核实官网信息，编写中英文介绍，提交到现有 Notion 资源库等待人工审批。

> 请使用这个技能处理下面的朋友推荐。核实官网、费用、地区和维护状态，检查是否已经收录，然后在 Notion 提交审批。

> 请使用这个技能处理我转交的 Tally 入驻推荐。推荐者的联系方式只用于内部核实。

> 请发布这些已经人工批准的 Notion 资源，完成网站更新、构建、部署和检查。

> 请每周一北京时间上午九点查找适合巫门网站的新资源，每次最多五项，核实后放到现有 Notion 资源库等待审批。没有新内容时保持安静。

这些文字用于向 AI 下达任务。提供仓库地址后，AI 仍需要读取文件，并具备相应账号权限。普通对话窗口可以整理材料；持续执行需要平台的定时任务功能或外部调度器。

## 账号与安装

- Notion：可以使用能够读写目标资源库的已连接 Notion 工具。运行 API 脚本时，由资源库所在工作区的所有者配置程序连接，启用读取、创建与更新内容。审批人员直接在 Notion 操作 `Published`，具体步骤见 [Notion 连接配置](references/review.md#连接与审批位置)。
- GitHub：网站协作者权限；发布通过网站现有分支、PR 和托管配置执行。
- 网站托管：沿用现有部署权限；如果当前网站使用 Cloudflare AI Search，还需要现有搜索同步配置。

本技能目录可以整体放入支持 Agent Skills 的工具的 skills 目录，文件夹名称保留 `womencareer-curator`。Node.js 22 及以上用于辅助脚本：

```sh
npm ci --ignore-scripts
node scripts/content.mjs inspect --site ../womencareer-directory
```

配置 `NOTION_TOKEN` 和 `NOTION_DATABASE_ID`。可以从 `.env.example` 创建本地 `.env`，或沿用网站已有的环境文件；不要把凭据发到聊天或提交到仓库。

```sh
node --env-file=.env scripts/notion.mjs inspect
node scripts/collect.mjs --url https://github.com/aliceyuruchan/womencareer-directory --format html --output work/site-source.json
node scripts/content.mjs validate --site ../womencareer-directory --candidate work/candidate.json
node --env-file=.env scripts/notion.mjs stage --site ../womencareer-directory --candidate work/candidate.json
node --env-file=.env scripts/notion.mjs approved --page-id PAGE_ID --output work/approved.json
```

`candidate.json` 由 AI 按照 [审批资料格式](references/review.md) 编写。`stage` 保存未批准草稿；`approved` 只读取人工批准结果并导出数据。辅助脚本不修改网站代码，也不执行部署。

## 人工审批

在现有 Notion 资源库建立一个筛选 `Published` 未勾选的视图，名称可以使用“待审批”。打开资源页面查看中英文草稿、核实依据、核实日期和草稿编号。人工批准时勾选 `Published`；需要补充或不收录时保持未勾选，并在页面写明意见。

勾选 `Published` 会使资源进入网站现有同步范围。请在确认具体草稿后操作。修改草稿内容需要重新核实和审批，流程见 [审批流程](references/review.md)。

## 验证

```sh
npm test
npm run test:network
node scripts/content.mjs inspect --site ../womencareer-directory
node --env-file=.env scripts/notion.mjs inspect
```

网络测试会访问真实公开网页、JSON API 与 RSS/Atom。Notion 检查只读数据库；创建审批草稿和生产发布需要在对应任务中获得授权。本地测试不代表已完成 Notion 入库或网站上线，运行记录保存在被 Git 忽略的 `work/` 中。
