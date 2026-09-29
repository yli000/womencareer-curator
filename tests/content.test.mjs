import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { canonicalUrl, findDuplicates, resourceHash, resourceSchema, validateCandidate } from "../scripts/content.mjs";

// 来源为网站 0f4293c381a71b6487dd1b9729f9e7060450ae00 中的公开条目。
const resource = JSON.parse(await fs.readFile(new URL("./fixtures/resource.json", import.meta.url), "utf8"));

test("网站现有真实资源能够通过字段检查", () => {
  assert.equal(resourceSchema.parse(resource).officialUrl, resource.officialUrl);
  assert.equal(findDuplicates(resource, [resource]).length, 1);
});

test("审批内容校验值忽略字段排列与空可选链接", () => {
  const reordered = Object.fromEntries(Object.entries(resource).reverse());
  assert.equal(resourceHash(reordered), resourceHash(resource));
  assert.equal(resourceHash({ ...resource, logoUrl: "" }), resourceHash(resource));
});

test("编辑费用或状态会改变审批内容校验值", () => {
  assert.notEqual(resourceHash({ ...resource, cost: "Paid" }), resourceHash(resource));
  assert.notEqual(resourceHash({ ...resource, status: "Archived" }), resourceHash(resource));
});

test("查重保留项目路径及功能参数并移除追踪参数", () => {
  assert.equal(canonicalUrl(`${resource.officialUrl}&utm_source=directory`), canonicalUrl(resource.officialUrl));
  assert.notEqual(canonicalUrl("https://github.com/ossu/computer-science"), canonicalUrl("https://github.com/ossu/math"));
  assert.notEqual(canonicalUrl("https://www.npmjs.com/package/remote-job-hunter?activeTab=versions"), canonicalUrl(resource.officialUrl));
});

test("网站资源字段拒绝审批开关与私人联系字段", () => {
  assert.throws(() => resourceSchema.parse({ ...resource, Published: true }));
  assert.throws(() => resourceSchema.parse({ ...resource, email: "" }));
});

test("没有核实材料的现有资源不能作为审批草稿提交", () => {
  assert.throws(() => validateCandidate({ schemaVersion: 1, resource }));
});
