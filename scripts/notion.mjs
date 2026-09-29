import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Client, collectPaginatedAPI } from "@notionhq/client";
import { readCandidate, resourceHash, resourceSchema, findDuplicates, validateCandidate } from "./content.mjs";
import { resolveOutput } from "./collect.mjs";

export const marker = "womencareer-curator-v1";
const reviewCaption = `${marker}:review`;
const metadataCaption = `${marker}:metadata`;
const regionTitle = `审批材料 · ${marker}`;
const maximumRequestBytes = 450_000;
const optionalProperties = new Set(["Name ZH", "Logo URL"]);

export const propertyMapping = Object.freeze([
  ["id", "ID", "number"], ["slug", "Slug", "rich_text"],
  ["name", "Name", "title"], ["nameZh", "Name ZH", "rich_text"],
  ["shortDescription", "Short Description", "rich_text"],
  ["shortDescriptionZh", "Short Description ZH", "rich_text"],
  ["category", "Category", "select"], ["tags", "Tags", "multi_select"],
  ["tagsZh", "Tags ZH", "multi_select"], ["region", "Region", "select"],
  ["type", "Type", "rich_text"], ["typeZh", "Type ZH", "rich_text"],
  ["language", "Language", "multi_select"], ["cost", "Cost", "select"],
  ["status", "Status", "select"], ["officialUrl", "Official URL", "url"],
  ["logoUrl", "Logo URL", "url"], ["featured", "Featured", "select"],
]);

export function splitText(value, maximum = 2000) {
  if (!Number.isSafeInteger(maximum) || maximum < 2) throw new Error("文本长度上限无效。");
  const chunks = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length + character.length > maximum) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function richText(value) {
  const result = splitText(value).map((content) => ({ type: "text", text: { content } }));
  if (result.length > 100) throw new Error("单个 Notion 字段超过 100 个文本片段。");
  return result;
}

function textValue(items = []) {
  return items.map((item) => item.plain_text ?? item.text?.content ?? "").join("");
}

export function assertDatabaseSchema(database) {
  const expected = [...propertyMapping.map(([, name, type]) => [name, type]), ["Published", "checkbox"]];
  for (const [name, type] of expected) {
    if (optionalProperties.has(name) && !database.properties?.[name]) continue;
    assertPropertyType(name, database.properties?.[name], type);
  }
}

function assertPropertyType(name, property, expectedType) {
  const allowed = name === "ID" ? ["number", "rich_text"] : name === "Featured" ? ["select", "checkbox"] : [expectedType];
  const type = property?.type ?? allowed.find((item) => property && item in property);
  if (!allowed.includes(type)) throw new Error(`Notion 字段 ${name} 必须存在且类型为 ${allowed.join(" 或 ")}。`);
  return type;
}

function numericId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Notion ID 必须为非负安全整数。");
  return String(value).padStart(3, "0");
}

export function readId(property) {
  const type = assertPropertyType("ID", property, "number");
  if (type === "number") return numericId(property.number);
  const value = textValue(property.rich_text).trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Notion ID 文本必须为安全整数编号。");
  return value;
}

export function featuredValue(property) {
  const type = assertPropertyType("Featured", property, "select");
  if (type === "checkbox") {
    if (typeof property.checkbox !== "boolean") throw new Error("Notion Featured checkbox 值无效。");
    return property.checkbox;
  }
  const value = property.select?.name?.trim().toUpperCase();
  if (value !== "TRUE" && value !== "FALSE") throw new Error("Notion Featured 选项必须为 TRUE 或 FALSE。");
  return value === "TRUE";
}

export function resourceToProperties(input, databaseProperties) {
  const resource = resourceSchema.parse(input);
  assertDatabaseSchema({ properties: databaseProperties });
  const properties = { Published: { checkbox: false } };
  for (const [key, name, expectedType] of propertyMapping) {
    const value = resource[key];
    const property = databaseProperties[name];
    if (!property) {
      if (optionalProperties.has(name) && !value) continue;
      throw new Error(`Notion 数据库缺少候选内容需要的字段 ${name}。`);
    }
    const type = assertPropertyType(name, property, expectedType);
    if (key === "id" && type === "number") {
      const id = Number(value);
      if (numericId(id) !== value) throw new Error("数字 ID 对应的候选编号需要使用至少三位数字，例如 097。");
      properties[name] = { number: id };
      continue;
    }
    if (key === "featured" && type === "select") {
      const selected = value ? "TRUE" : "FALSE";
      const options = property.select?.options?.filter((option) => option.name.trim().toUpperCase() === selected) ?? [];
      if (options.length !== 1) throw new Error(`Notion Featured 需要且只能有一个 ${selected} 选项，请由维护者检查选项设置。`);
      properties[name] = { select: { name: options[0].name } };
      continue;
    }
    if (type === "rich_text" || type === "title") properties[name] = { [type]: richText(value ?? "") };
    if (type === "select") {
      if (value.includes(",") || value.length > 100) throw new Error(`Notion 选项 ${name} 包含逗号或超过 100 个字符。`);
      properties[name] = { select: { name: value } };
    }
    if (type === "multi_select") {
      const options = value ?? [];
      if (options.length > 100 || new Set(options.map((item) => item.toLowerCase())).size !== options.length) {
        throw new Error(`Notion 多选字段 ${name} 超过 100 项或包含重复选项。`);
      }
      if (options.some((item) => item.includes(",") || item.length > 100)) throw new Error(`Notion 选项 ${name} 包含逗号或超过 100 个字符。`);
      properties[name] = { multi_select: options.map((item) => ({ name: item })) };
    }
    if (type === "url") {
      if (value && value.length > 2000) throw new Error(`Notion 链接字段 ${name} 超过 2000 个字符。`);
      properties[name] = { url: value || null };
    }
    if (type === "checkbox") properties[name] = { checkbox: value };
  }
  assertRequestSize({ properties });
  return properties;
}

export function propertiesToResource(properties) {
  const resource = {};
  for (const [key, name, expectedType] of propertyMapping) {
    const property = properties[name];
    if (!property && optionalProperties.has(name)) continue;
    const type = assertPropertyType(name, property, expectedType);
    if (!(type in property)) throw new Error(`Notion 页面字段 ${name} 缺少值。`);
    if (key === "id") {
      resource.id = readId(property);
      continue;
    }
    if (key === "featured") {
      resource.featured = featuredValue(property);
      continue;
    }
    if (type === "title" || type === "rich_text") resource[key] = textValue(property[type]).trim();
    if (type === "select") resource[key] = property.select?.name ?? "";
    if (type === "multi_select") resource[key] = property.multi_select.map((item) => item.name);
    if (type === "url") resource[key] = property.url ?? "";
    if (type === "checkbox") resource[key] = property.checkbox;
  }
  if (!resource.tagsZh.length) delete resource.tagsZh;
  return resourceSchema.parse(resource);
}

function assertRequestSize(payload) {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maximumRequestBytes) throw new Error("Notion 请求超过安全长度，需要缩短审批材料。");
}

export function chunkBlocks(blocks) {
  const batches = [];
  let batch = [];
  for (const block of blocks) {
    assertRequestSize({ children: [block] });
    if (batch.length >= 100 || Buffer.byteLength(JSON.stringify({ children: [...batch, block] }), "utf8") > maximumRequestBytes) {
      batches.push(batch);
      batch = [];
    }
    batch.push(block);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function encodeMetadata(value) {
  return splitText(JSON.stringify(value)).map((content, index, parts) => ({
    object: "block", type: "code", code: {
      language: "json", rich_text: richText(content),
      caption: richText(`${metadataCaption}:${index + 1}/${parts.length}`),
    },
  }));
}

export function decodeMetadata(blocks) {
  const parts = blocks.filter((block) => block.type === "code" && textValue(block.code.caption).startsWith(`${metadataCaption}:`));
  if (!parts.length) throw new Error("页面缺少完整的本技能审批元数据，需要重新核实并提交草稿。");
  const contents = parts.map((block, index) => {
    if (textValue(block.code.caption) !== `${metadataCaption}:${index + 1}/${parts.length}`) throw new Error("审批元数据顺序或数量不符，需要重新提交草稿。");
    return textValue(block.code.rich_text);
  });
  const metadata = JSON.parse(contents.join(""));
  if (metadata.marker !== marker || metadata.schemaVersion !== 1 || !metadata.candidate || !metadata.draftHash) throw new Error("审批元数据格式不符。");
  if (resourceHash(metadata.candidate.resource) !== metadata.draftHash) throw new Error("审批元数据与内容校验值不符。");
  return metadata;
}

export function buildReviewBlocks(input) {
  const candidate = validateCandidate(input);
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(`${candidate.intake.sourceRef} ${candidate.intake.submissionId ?? ""}`)) {
    throw new Error("来源说明与提交编号不能包含私人邮箱，请使用内部编号。");
  }
  const resource = candidate.resource;
  const review = [
    "人工审批说明", "请阅读页面属性和下列证据。确认后由人工勾选 Published。",
    "修改资源字段后，请重新核实并更新本页草稿。审批意见可写入页面留言或本区域中的新增内容。",
    `名称：${resource.nameZh || resource.name}`, `官方链接：${resource.officialUrl}`,
    `介绍：${resource.shortDescriptionZh}`, `英文介绍：${resource.shortDescription}`,
    `分类：${resource.category}；地区：${resource.region}；语言：${resource.language.join("、")}`,
    `费用：${resource.cost}；状态：${resource.status}`,
    `收集方式：${candidate.intake.kind}；接收时间：${candidate.intake.receivedAt}`,
    `核实时间：${candidate.verification.checkedAt}`, `收录理由：${candidate.verification.relevance}`,
    "核实证据", ...candidate.verification.evidence.flatMap((item, index) => [
      `${index + 1}. ${item.title}`, `来源：${item.url}`, `访问时间：${item.checkedAt}`,
      `支持字段：${item.claims.join("、")}`, `核实说明：${item.note}`,
    ]), "待确认事项：无",
  ].join("\n\n");
  const blocks = splitText(review).map((content) => ({
    object: "block", type: "code", code: { language: "plain text", rich_text: richText(content), caption: richText(reviewCaption) },
  }));
  return [...blocks, ...encodeMetadata({ marker, schemaVersion: 1, candidate, draftHash: resourceHash(resource) })];
}

function normalizedId(value) {
  return value.replaceAll("-", "").toLowerCase();
}

function assertPage(page, databaseId, published) {
  if (page.object !== "page" || !page.properties || page.archived || page.in_trash) throw new Error("Notion 页面不可用或已经归档。");
  if (page.parent?.type !== "database_id" || normalizedId(page.parent.database_id) !== normalizedId(databaseId)) throw new Error("页面不属于配置的 Notion 数据库。");
  if (page.properties.Published?.type !== "checkbox" || page.properties.Published.checkbox !== published) {
    throw new Error(published ? "此页面尚未由人工勾选 Published。" : "此页面已经勾选 Published；请由人工取消勾选并重新核实。");
  }
}

async function allPages(client, databaseId) {
  const pages = await collectPaginatedAPI(client.databases.query, { database_id: databaseId, page_size: 100 });
  if (pages.some((page) => page.object !== "page" || !page.properties)) throw new Error("数据库返回不完整页面，无法完成查重。");
  return pages;
}

async function completePageProperties(client, page) {
  for (const [, name] of propertyMapping) {
    const property = page.properties?.[name];
    const type = property?.type;
    if (["title", "rich_text"].includes(type) && property?.[type]?.length >= 25) {
      const values = await collectPaginatedAPI(client.pages.properties.retrieve, { page_id: page.id, property_id: property.id, page_size: 100 });
      if (values.some((item) => item.type !== type)) throw new Error(`Notion 字段 ${name} 的分页内容类型不符。`);
      property[type] = values.map((item) => item[type]);
    }
  }
  return page;
}

async function children(client, blockId) {
  const blocks = await collectPaginatedAPI(client.blocks.children.list, { block_id: blockId, page_size: 100 });
  if (blocks.some((block) => !block.type)) throw new Error("审批区域返回不完整内容。");
  return blocks;
}

async function readRegion(client, pageId) {
  const regions = (await children(client, pageId)).filter((block) => block.type === "toggle" && textValue(block.toggle.rich_text) === regionTitle);
  if (regions.length !== 1) throw new Error("页面需要且只能包含一个本技能审批区域。");
  return { region: regions[0], blocks: await children(client, regions[0].id) };
}

export function identityFromPage(page) {
  const properties = page.properties;
  for (const [name, type] of [["Slug", "rich_text"], ["Name", "title"], ["Official URL", "url"]]) {
    if (properties[name]?.type !== type) throw new Error(`页面 ${page.id} 缺少查重字段 ${name}。`);
  }
  return {
    id: readId(properties.ID), slug: textValue(properties.Slug.rich_text).trim(),
    name: textValue(properties.Name.title).trim(), officialUrl: properties["Official URL"].url,
  };
}

export function duplicatePages(resource, pages) {
  return pages.filter((page) => {
    const identity = identityFromPage(page);
    if (Number(identity.id) === Number(resource.id) || identity.slug === resource.slug || identity.name.toLowerCase() === resource.name.toLowerCase()) return true;
    if (!identity.officialUrl) return false;
    if (!URL.canParse(identity.officialUrl)) throw new Error(`页面 ${page.id} 的 Official URL 无效，请检查后重试。`);
    return findDuplicates(resource, [identity]).length > 0;
  });
}

function isManagedBlock(block) {
  if (block.type !== "code") return false;
  const caption = textValue(block.code.caption);
  return caption === reviewCaption || caption.startsWith(`${metadataCaption}:`);
}

async function appendBlocks(client, blockId, blocks) {
  for (const batch of chunkBlocks(blocks)) await client.blocks.children.append({ block_id: blockId, children: batch });
}

export async function inspect(client, databaseId) {
  const database = await client.databases.retrieve({ database_id: databaseId });
  const pages = await allPages(client, databaseId);
  const ids = pages.map((page) => readId(page.properties.ID));
  const published = pages.filter((page) => page.properties.Published?.checkbox === true).length;
  return {
    databaseId: database.id, schema: Object.entries(database.properties).map(([name, property]) => ({ name, type: property.type })),
    count: pages.length, draftCount: pages.length - published, publishedCount: published,
    nextId: numericId(Math.max(0, ...ids.map(Number)) + 1),
  };
}

export async function stage(client, databaseId, candidateFile, sitePath, pageId) {
  const candidate = await readCandidate(candidateFile, sitePath);
  const blocks = buildReviewBlocks(candidate);
  chunkBlocks(blocks);
  const database = await client.databases.retrieve({ database_id: databaseId });
  assertDatabaseSchema(database);
  const properties = resourceToProperties(candidate.resource, database.properties);
  console.error("查重与提交必须串行执行；请保持此数据库只有一个收集任务正在提交，并在完成前暂停人工修改当前草稿。");
  const pages = await allPages(client, databaseId);
  const existing = pageId ? await client.pages.retrieve({ page_id: pageId }) : undefined;
  let currentRegion;
  if (existing) {
    assertPage(existing, databaseId, false);
    const identity = identityFromPage(existing);
    if (identity.id !== candidate.resource.id || identity.slug !== candidate.resource.slug) throw new Error("更新草稿必须保留现有 ID 和 Slug。");
    currentRegion = await readRegion(client, existing.id);
  }
  const duplicates = duplicatePages(candidate.resource, pages.filter((page) => !existing || page.id !== existing.id));
  if (duplicates.length) {
    if (!existing && duplicates.length === 1 && duplicates[0].properties.Published.checkbox === false) {
      const duplicate = duplicates[0];
      const { blocks: previousBlocks } = await readRegion(client, duplicate.id);
      const metadata = decodeMetadata(previousBlocks);
      await completePageProperties(client, duplicate);
      if (metadata.draftHash === resourceHash(candidate.resource) && resourceHash(propertiesToResource(duplicate.properties)) === metadata.draftHash && JSON.stringify(metadata.candidate) === JSON.stringify(candidate)) {
        return { status: "already_exists", pageId: duplicate.id, pageUrl: duplicate.url, draftHash: metadata.draftHash };
      }
    }
    throw new Error(`Notion 中已有重复条目：${duplicates.map((page) => page.id).join("、")}。重新核实同一草稿请使用 --page-id。`);
  }
  let page;
  let region;
  if (existing) {
    const latest = await client.pages.retrieve({ page_id: existing.id });
    assertPage(latest, databaseId, false);
    if (latest.last_edited_time !== existing.last_edited_time) throw new Error("草稿在检查期间已经修改，请重新读取后重试。");
    page = await client.pages.update({ page_id: existing.id, properties });
    region = currentRegion.region;
    // 仅更新带本技能标识的内容，其他页面内容与人工留言保留。
    for (const block of currentRegion.blocks.filter(isManagedBlock)) await client.blocks.delete({ block_id: block.id });
  } else {
    const payload = { parent: { database_id: databaseId }, properties, children: [{ object: "block", type: "toggle", toggle: { rich_text: richText(regionTitle) } }] };
    assertRequestSize(payload);
    page = await client.pages.create(payload);
    console.error(JSON.stringify({ status: "draft_created", pageId: page.id, pageUrl: page.url }));
    ({ region } = await readRegion(client, page.id));
  }
  await appendBlocks(client, region.id, blocks);
  const storedPage = await completePageProperties(client, await client.pages.retrieve({ page_id: page.id }));
  assertPage(storedPage, databaseId, false);
  const stored = decodeMetadata((await readRegion(client, page.id)).blocks);
  if (resourceHash(propertiesToResource(storedPage.properties)) !== stored.draftHash || JSON.stringify(stored.candidate) !== JSON.stringify(candidate)) throw new Error("保存后的草稿与提交内容不一致，请重新检查页面。");
  return { status: existing ? "updated" : "created", pageId: page.id, pageUrl: page.url, draftHash: stored.draftHash };
}

export async function approved(client, databaseId, pageId, output) {
  const destination = await resolveOutput(output);
  const database = await client.databases.retrieve({ database_id: databaseId });
  assertDatabaseSchema(database);
  const page = await completePageProperties(client, await client.pages.retrieve({ page_id: pageId }));
  assertPage(page, databaseId, true);
  const metadata = decodeMetadata((await readRegion(client, page.id)).blocks);
  const candidate = validateCandidate(metadata.candidate);
  const resource = propertiesToResource(page.properties);
  const hash = resourceHash(resource);
  if (hash !== metadata.draftHash) throw new Error("审批页面字段与已经核实的资源内容不一致。请由人工取消 Published，重新核实，并使用 stage --page-id 更新本页草稿后再次审批。");
  const latest = await completePageProperties(client, await client.pages.retrieve({ page_id: page.id }));
  assertPage(latest, databaseId, true);
  if (latest.last_edited_time !== page.last_edited_time || resourceHash(propertiesToResource(latest.properties)) !== hash) throw new Error("页面在审批检查期间已经修改，请重新读取后重试。");
  const result = { schemaVersion: 1, pageId: page.id, pageUrl: page.url, approvedAt: page.last_edited_time, resourceHash: hash, resource, verification: candidate.verification };
  await fs.writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { pageId: page.id, pageUrl: page.url, output: destination, resourceHash: hash };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    candidate: { type: "string" }, site: { type: "string" }, "page-id": { type: "string" }, output: { type: "string" },
  } });
  if (positionals.length !== 1 || !["inspect", "stage", "approved"].includes(positionals[0])) throw new Error("用法：notion.mjs inspect；stage --candidate FILE --site SITE [--page-id ID]；approved --page-id ID --output FILE。");
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!token?.trim() || !databaseId?.trim()) throw new Error("需要配置 NOTION_TOKEN 和 NOTION_DATABASE_ID。");
  const client = new Client({ auth: token, notionVersion: "2022-06-28" });
  let result;
  if (positionals[0] === "inspect") result = await inspect(client, databaseId);
  if (positionals[0] === "stage") {
    if (!values.candidate || !values.site) throw new Error("stage 需要 --candidate 和 --site。");
    result = await stage(client, databaseId, values.candidate, values.site, values["page-id"]);
  }
  if (positionals[0] === "approved") {
    if (!values["page-id"] || !values.output) throw new Error("approved 需要 --page-id 和 --output。");
    result = await approved(client, databaseId, values["page-id"], values.output);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
