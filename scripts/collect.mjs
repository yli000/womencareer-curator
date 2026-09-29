import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIMEType, parseArgs } from 'node:util';
import { load, loadBuffer } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import ipaddr from 'ipaddr.js';

const formats = new Set(['html', 'json', 'rss']);
const accepts = {
  html: 'text/html, application/xhtml+xml',
  json: 'application/json',
  rss: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
};

export function validateUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('来源地址必须使用 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new Error('来源地址不能包含账号或密码；API 凭据请使用 --token-env。');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (hostname === 'localhost' || /\.(localhost|local|internal|lan)$/.test(hostname)) {
    throw new Error('来源地址必须指向公开网络。');
  }
  if (ipaddr.isValid(hostname)) assertPublicAddress(hostname);
  url.hash = '';
  return url;
}

export function assertPublicAddress(value) {
  const address = ipaddr.process(value);
  if (address.range() !== 'unicast') {
    throw new Error(`来源地址必须指向公开网络：${value}`);
  }
}

async function publicAddresses(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname)) {
    assertPublicAddress(hostname);
    return [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
  }
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
  signal.throwIfAborted();
  if (!addresses.length) throw new Error('来源域名没有可连接的地址。');
  for (const entry of addresses) assertPublicAddress(entry.address);
  return addresses;
}

function validateContentType(header, format) {
  if (!header) throw new Error('来源没有提供 Content-Type。');
  const mime = new MIMEType(header);
  const type = mime.essence;
  const valid = format === 'json'
    ? type === 'application/json' || type.endsWith('+json')
    : format === 'html'
      ? ['text/html', 'application/xhtml+xml'].includes(type)
      : ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'].includes(type);
  if (!valid) throw new Error(`来源 Content-Type ${type} 与 --format ${format} 不匹配。`);
  return mime;
}

function download(url, addresses, { format, token, maxBytes, signal }) {
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  const headers = {
    Accept: accepts[format],
    'Accept-Encoding': 'identity',
    'User-Agent': 'womencareer-curator/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const operation = request(url, {
      method: 'GET', headers, signal, agent: false,
      // 连接仅使用本次已经核验的 DNS 地址。
      lookup(hostname, options, callback) {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        operation.destroy(new Error('来源返回重定向；请核实目标地址后使用完整目标 URL。'));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        operation.destroy(new Error(`来源返回 HTTP ${response.statusCode}。`));
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        operation.destroy(new Error('来源未遵守 Accept-Encoding: identity。'));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        operation.destroy(new Error(`来源内容超过 ${maxBytes} 字节。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) operation.destroy(new Error(`来源内容超过 ${maxBytes} 字节。`));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: response.headers }));
    });
    operation.on('error', reject);
    operation.end();
  });
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function absoluteLinks(values, baseUrl) {
  const links = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || !URL.canParse(value, baseUrl)) continue;
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    links.add(url.href);
  }
  return [...links];
}

function htmlFields(buffer, sourceUrl, mime) {
  const charset = mime.params.get('charset');
  const $ = loadBuffer(buffer, charset ? { encoding: { transportLayerEncodingLabel: charset } } : {});
  const title = normalizeText($('title').first().text());
  const base = $('base[href]').first().attr('href');
  const baseUrl = base && URL.canParse(base, sourceUrl) ? new URL(base, sourceUrl).href : sourceUrl;
  const links = absoluteLinks($('a[href]').map((index, element) => $(element).attr('href')).get(), baseUrl);
  $('script, style, noscript, template, svg').remove();
  $('br, p, div, li, h1, h2, h3, h4, h5, h6, section, article, tr').append('\n');
  return { title, text: normalizeText($('body').text()), links };
}

function xmlText(value) {
  if (typeof value === 'string') return normalizeText(load(value, null, false).text());
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return xmlText(value['#text']);
  return '';
}

function xmlLinks(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry['@_href'] ?? entry['#text'];
  });
}

function rssFields(buffer, sourceUrl) {
  const validation = XMLValidator.validate(buffer.toString('utf8'));
  if (validation !== true) throw new Error(`RSS XML 无效：${validation.err.msg}`);
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(buffer);
  const feed = data.rss?.channel ?? data.feed;
  if (!feed || typeof feed !== 'object') throw new Error('来源内容没有 RSS channel 或 Atom feed。');
  const entries = feed.item ?? feed.entry ?? [];
  const items = Array.isArray(entries) ? entries : [entries];
  const nodes = [feed, ...items];
  const text = nodes.flatMap((entry) => [entry.title, entry.description, entry.subtitle, entry.summary, entry.content, entry['content:encoded']])
    .map(xmlText).filter(Boolean).join('\n\n');
  return {
    title: xmlText(feed.title), text,
    links: absoluteLinks(nodes.flatMap((entry) => xmlLinks(entry.link)), sourceUrl), data,
  };
}

export async function collect({ url: value, format = 'html', tokenEnv, timeoutMs = 30000, maxBytes = 5 * 1024 * 1024 }) {
  if (!formats.has(format)) throw new Error('--format 必须为 html、json 或 rss。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('--timeout-ms 必须为 1 至 120000 的整数。');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw new Error('--max-bytes 必须为 1 至 20971520 的整数。');
  const url = validateUrl(value);
  if (tokenEnv && (format !== 'json' || url.protocol !== 'https:')) {
    throw new Error('--token-env 仅用于 HTTPS JSON API。');
  }
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('--token-env 必须为有效的环境变量名称。');
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (tokenEnv && !token) throw new Error(`环境变量 ${tokenEnv} 没有提供 API 凭据。`);
  const signal = AbortSignal.timeout(timeoutMs);
  const addresses = await publicAddresses(url, signal);
  const { buffer, headers } = await download(url, addresses, { format, token, maxBytes, signal });
  const mime = validateContentType(headers['content-type'], format);
  let fields;
  if (format === 'html') fields = htmlFields(buffer, url.href, mime);
  else if (format === 'rss') fields = rssFields(buffer, url.href);
  else {
    const data = JSON.parse(buffer.toString('utf8'));
    fields = { title: '', text: JSON.stringify(data, null, 2), links: [], data };
  }
  return {
    schemaVersion: 1, sourceUrl: url.href, finalUrl: url.href,
    fetchedAt: new Date().toISOString(), format, ...fields,
  };
}

export async function resolveOutput(value, cwd = process.cwd()) {
  const root = await realpath(cwd);
  const destination = path.resolve(root, value);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('--output 必须位于当前工作目录内部。');
  }
  if (path.extname(destination).toLowerCase() !== '.json') throw new Error('--output 必须使用 .json 文件名。');
  let current = root;
  const directories = path.dirname(relative) === '.' ? [] : path.dirname(relative).split(path.sep);
  for (const component of directories) {
    current = path.join(current, component);
    if (existsSync(current)) {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('输出目录必须为项目内部的普通目录。');
    } else await mkdir(current);
    const actual = path.relative(root, await realpath(current));
    if (actual.startsWith(`..${path.sep}`) || actual === '..' || path.isAbsolute(actual)) {
      throw new Error('输出目录必须位于当前工作目录内部。');
    }
  }
  if (existsSync(destination)) throw new Error('输出文件已经存在；请使用新的文件名保存本次抓取结果。');
  return destination;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' }, format: { type: 'string', default: 'html' },
      output: { type: 'string' }, 'token-env': { type: 'string' },
      'timeout-ms': { type: 'string', default: '30000' },
      'max-bytes': { type: 'string', default: '5242880' }, help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('用法：node scripts/collect.mjs --url HTTPS_URL --format html|json|rss --output work/source.json [--token-env API_TOKEN] [--timeout-ms 30000] [--max-bytes 5242880]');
    return;
  }
  if (!values.url || !values.output) throw new Error('必须提供 --url 和 --output。');
  const output = await resolveOutput(values.output);
  const result = await collect({
    url: values.url, format: values.format, tokenEnv: values['token-env'],
    timeoutMs: Number(values['timeout-ms']), maxBytes: Number(values['max-bytes']),
  });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`已保存原始提取结果：${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
