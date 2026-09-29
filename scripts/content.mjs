import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import JSON5 from "json5";
import { z } from "zod";

export const categories = ["Community", "Learning", "Book", "Scholarship", "Fellowship", "Mentorship", "Conference", "Tool", "Podcast", "Newsletter", "Research", "Open Source"];
const text = z.string().trim().min(1);
const httpUrl = z.string().url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "链接必须使用 HTTP 或 HTTPS，且不含登录信息");
const timestamp = z.string().datetime({ offset: true });
const tags = z.array(text).min(1);

export const resourceSchema = z.object({
  id: z.string().regex(/^\d+$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: text,
  nameZh: z.string().trim().transform((value) => value || undefined).optional(),
  shortDescription: text,
  shortDescriptionZh: z.string().trim().transform((value) => value || undefined).optional(),
  category: z.enum(categories),
  tags,
  tagsZh: z.array(text).optional(),
  region: text,
  type: text,
  typeZh: z.string().trim().transform((value) => value || undefined).optional(),
  language: tags,
  cost: z.enum(["Free", "Paid", "Mixed"]),
  status: z.enum(["Active", "Archived"]),
  officialUrl: httpUrl,
  logoUrl: z.union([httpUrl, z.literal("")]).transform((value) => value || undefined).optional(),
  featured: z.boolean(),
}).strict();

export const candidateSchema = z.object({
  schemaVersion: z.literal(1),
  intake: z.object({
    kind: z.enum(["discovery", "recommendation", "tally", "api"]),
    receivedAt: timestamp,
    sourceRef: text,
    submissionId: text.optional(),
  }).strict(),
  resource: resourceSchema,
  verification: z.object({
    checkedAt: timestamp,
    relevance: text,
    evidence: z.array(z.object({
      url: httpUrl,
      title: text,
      checkedAt: timestamp,
      claims: z.array(z.enum(["name", "officialUrl", "shortDescription", "region", "language", "cost", "status", "eligibility", "deadline"])).min(1),
      note: text,
    }).strict()).min(1),
    unresolved: z.array(text),
  }).strict(),
}).strict();

export function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.host}${url.pathname}${url.search}`;
}

export function resourceHash(resource) {
  return createHash("sha256").update(JSON.stringify(resourceSchema.parse(resource))).digest("hex");
}

export function validateCandidate(input, now = new Date()) {
  const candidate = candidateSchema.parse(input);
  if (candidate.verification.unresolved.length) throw new Error("仍有未确认事项，保留在资料收集区，补充核实后提交审批。");
  if (!candidate.resource.shortDescriptionZh?.trim() || !candidate.resource.typeZh?.trim() || !candidate.resource.tagsZh?.length) {
    throw new Error("审批草稿需要中文介绍、中文类型和中文标签。");
  }
  const required = ["name", "officialUrl", "shortDescription", "region", "language", "cost", "status"];
  const covered = new Set(candidate.verification.evidence.flatMap((item) => item.claims));
  for (const field of required) if (!covered.has(field)) throw new Error(`缺少字段核实依据：${field}`);
  for (const value of [candidate.intake.receivedAt, candidate.verification.checkedAt, ...candidate.verification.evidence.map((item) => item.checkedAt)]) {
    const age = now.getTime() - new Date(value).getTime();
    if (age < -300_000) throw new Error("记录时间不能在未来。");
  }
  for (const value of [candidate.verification.checkedAt, ...candidate.verification.evidence.map((item) => item.checkedAt)]) {
    const age = now.getTime() - new Date(value).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) throw new Error("核实时间超过七天，需要重新访问来源。");
  }
  if (candidate.resource.featured) throw new Error("新资源的 featured 使用 false，推荐位置由网站维护者单独管理。");
  return candidate;
}

export async function readResources(sitePath) {
  const file = path.join(sitePath, "data", "resources.ts");
  const source = ts.createSourceFile(file, await fs.readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error("资源文件包含 TypeScript 语法错误。");
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap((item) => [...item.declarationList.declarations]);
  const declaration = declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === "resources");
  if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) throw new Error("未找到 resources 数组，请检查网站当前结构。");
  const resources = JSON5.parse(declaration.initializer.getText(source));
  if (!Array.isArray(resources) || resources.length === 0) throw new Error("网站资源数组为空。");
  return resources.map((item) => resourceSchema.parse(item));
}

export function findDuplicates(resource, resources) {
  return resources.filter((item) => item.id === resource.id || item.slug === resource.slug || canonicalUrl(item.officialUrl) === canonicalUrl(resource.officialUrl) || item.name.toLowerCase().trim() === resource.name.toLowerCase().trim());
}

export async function readCandidate(file, sitePath) {
  const candidate = validateCandidate(JSON.parse(await fs.readFile(file, "utf8")));
  const duplicates = findDuplicates(candidate.resource, await readResources(sitePath));
  if (duplicates.length) throw new Error(`与现有资源重复：${duplicates.map((item) => `${item.id} ${item.name}`).join("；")}`);
  return candidate;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    site: { type: "string" }, candidate: { type: "string" },
  } });
  if (!values.site) throw new Error("需要 --site 网站仓库路径。");
  if (positionals[0] === "inspect") {
    const resources = await readResources(values.site);
    const ids = resources.map((item) => Number(item.id));
    if (ids.some((id) => !Number.isSafeInteger(id))) throw new Error("ID 超出安全整数范围。");
    console.log(JSON.stringify({ count: resources.length, nextId: String(Math.max(...ids) + 1).padStart(3, "0"), categories, regions: [...new Set(resources.map((item) => item.region))], languages: [...new Set(resources.flatMap((item) => item.language))], tags: [...new Set(resources.flatMap((item) => item.tags))] }, null, 2));
  } else if (positionals[0] === "validate" && values.candidate) {
    const candidate = await readCandidate(values.candidate, values.site);
    console.log(JSON.stringify({ valid: true, id: candidate.resource.id, name: candidate.resource.name, draftHash: resourceHash(candidate.resource) }, null, 2));
  } else {
    throw new Error("用法：content.mjs inspect --site PATH，或 validate --site PATH --candidate FILE。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
