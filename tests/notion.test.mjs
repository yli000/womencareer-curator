import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { resourceHash } from "../scripts/content.mjs";
import { marker, propertyMapping, assertDatabaseSchema, resourceToProperties, propertiesToResource, readId, featuredValue, identityFromPage, duplicatePages, splitText, chunkBlocks, encodeMetadata, decodeMetadata } from "../scripts/notion.mjs";

// 使用网站公开资源验证实际 SDK 请求内容，不创建审批记录。
const resource = JSON.parse(await fs.readFile(new URL("./fixtures/resource.json", import.meta.url), "utf8"));
const databaseProperties = {
  ...Object.fromEntries(propertyMapping.map(([, name, type]) => [name, { type, [type]: {} }])),
  Featured: { type: "select", select: { options: [{ name: "TRUE" }, { name: "FALSE" }] } },
  Published: { type: "checkbox", checkbox: {} },
};

test("网站真实资源转换为完整 Notion 草稿属性，Published 保持 false", () => {
  const properties = resourceToProperties(resource, databaseProperties);
  assert.equal(properties.Published.checkbox, false);
  assert.equal(Object.keys(properties).length, propertyMapping.length + 1);
  assert.equal(properties["Official URL"].url, resource.officialUrl);
  assert.equal(properties.Name.title[0].text.content, resource.name);
  assert.equal(properties.ID.number, 1);
  assert.deepEqual(properties.Featured, { select: { name: "FALSE" } });
  assert.equal(resourceHash(propertiesToResource(properties)), resourceHash(resource));
});

test("空可选字段从 SDK 请求还原后保留相同内容校验值", () => {
  const properties = resourceToProperties({ ...resource, nameZh: "", logoUrl: "" }, databaseProperties);
  assert.equal(properties["Logo URL"].url, null);
  assert.equal(resourceHash(propertiesToResource(properties)), resourceHash({ ...resource, nameZh: "", logoUrl: "" }));
});

test("候选未填写可选内容时，数据库允许缺少 Name ZH 和 Logo URL", () => {
  const available = Object.fromEntries(Object.entries(databaseProperties).filter(([name]) => !["Name ZH", "Logo URL"].includes(name)));
  const candidateResource = { ...resource, nameZh: "", logoUrl: "" };
  const properties = resourceToProperties(candidateResource, available);
  assert.equal("Name ZH" in properties, false);
  assert.equal("Logo URL" in properties, false);
  assert.equal(resourceHash(propertiesToResource(properties)), resourceHash(candidateResource));
  assert.throws(() => resourceToProperties(resource, available), /Name ZH/);
  assert.throws(() => resourceToProperties({ ...candidateResource, logoUrl: resource.officialUrl }, available), /Logo URL/);
});

test("数字 ID 和 Featured TRUE 写入后保留原值", () => {
  const numberedResource = { ...resource, featured: true };
  const properties = resourceToProperties(numberedResource, databaseProperties);
  assert.equal(properties.ID.number, Number(resource.id));
  assert.deepEqual(properties.Featured, { select: { name: "TRUE" } });
  assert.equal(properties.Published.checkbox, false);
  assert.deepEqual(propertiesToResource(properties), { ...numberedResource, logoUrl: undefined });
  assert.equal(readId({ type: "number", number: Number(resource.id) }), resource.id);
  assert.equal(featuredValue({ type: "select", select: { name: "TRUE" } }), true);
});

test("数据库使用文本 ID 和 Featured checkbox 时按其实际类型转换", () => {
  const properties = resourceToProperties(resource, {
    ...databaseProperties,
    ID: { type: "rich_text", rich_text: {} },
    Featured: { type: "checkbox", checkbox: {} },
  });
  assert.equal(properties.ID.rich_text[0].text.content, resource.id);
  assert.equal(properties.Featured.checkbox, false);
  assert.equal(resourceHash(propertiesToResource(properties)), resourceHash(resource));
});

test("数字 ID 支持查重，忽略文本编号中的前导零", () => {
  const page = { properties: {
    ID: { type: "number", number: 97 },
    Slug: { type: "rich_text", rich_text: [{ text: { content: resource.slug } }] },
    Name: { type: "title", title: [{ text: { content: resource.name } }] },
    "Official URL": { type: "url", url: resource.officialUrl },
  } };
  assert.equal(identityFromPage(page).id, "097");
  assert.deepEqual(duplicatePages({ ...resource, id: "97", slug: "other-resource", name: "Other Resource", officialUrl: "https://example.com" }, [page]), [page]);
});

test("Featured 写入复用数据库选项，缺少明确选项时停止", () => {
  const properties = resourceToProperties(resource, {
    ...databaseProperties, Featured: { type: "select", select: { options: [{ name: "false" }] } },
  });
  assert.equal(properties.Featured.select.name, "false");
  assert.equal(propertiesToResource(properties).featured, false);
  assert.throws(() => resourceToProperties(resource, {
    ...databaseProperties, Featured: { type: "select", select: { options: [{ name: "TRUE" }] } },
  }), /FALSE/);
  for (const select of [null, { name: "YES" }]) assert.throws(() => featuredValue({ type: "select", select }), /TRUE 或 FALSE/);
});

test("ID 类型、值或候选编号格式无效时停止，Published 必须为 checkbox", () => {
  for (const number of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => readId({ type: "number", number }), /安全整数/);
  assert.throws(() => resourceToProperties({ ...resource, id: "97" }, databaseProperties), /至少三位/);
  assert.throws(() => assertDatabaseSchema({ properties: { ...databaseProperties, ID: { type: "unique_id" } } }), /ID/);
  assert.throws(() => assertDatabaseSchema({ properties: { ...databaseProperties, Published: { type: "select" } } }), /Published/);
});

test("长文本与 Unicode 字符按 Notion 的字符限制分段", () => {
  const value = `${resource.shortDescriptionZh}\n😀`.repeat(150);
  const chunks = splitText(value);
  assert.equal(chunks.join(""), value);
  assert.ok(chunks.every((item) => item.length <= 2000));
  assert.ok(chunks.every((item) => !/[\uD800-\uDBFF]$/.test(item)));
});

test("超过 100 个内容块时生成多次 SDK 请求", () => {
  const blocks = Array.from({ length: 201 }, () => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: resource.name } }] } }));
  const batches = chunkBlocks(blocks);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 1]);
  assert.deepEqual(batches.flat(), blocks);
});

test("真实资源的 JSON 元数据可完整分段读取且拒绝缺失片段", () => {
  const metadata = { marker, schemaVersion: 1, candidate: { resource }, draftHash: resourceHash(resource) };
  const blocks = encodeMetadata(metadata);
  assert.deepEqual(decodeMetadata(blocks), metadata);
  assert.throws(() => decodeMetadata([]), /缺少/);
  const largeMetadata = { ...metadata, material: resource.shortDescriptionZh.repeat(200) };
  const largeBlocks = encodeMetadata(largeMetadata);
  assert.ok(largeBlocks.length > 1);
  assert.deepEqual(decodeMetadata(largeBlocks), largeMetadata);
  assert.throws(() => decodeMetadata(largeBlocks.slice(1)), /顺序或数量/);
});

test("修改资源内容会被元数据完整性检查拒绝", () => {
  const blocks = encodeMetadata({ marker, schemaVersion: 1, candidate: { resource: { ...resource, cost: "Paid" } }, draftHash: resourceHash(resource) });
  assert.throws(() => decodeMetadata(blocks), /校验值不符/);
});
