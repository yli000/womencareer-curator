import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertPublicAddress, collect, resolveOutput, validateUrl } from '../scripts/collect.mjs';

test('公开地址检查拒绝本机、私有网络和特殊地址', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.throws(() => assertPublicAddress(address), /公开网络/);
  }
  assert.doesNotThrow(() => assertPublicAddress('8.8.8.8'));
  assert.doesNotThrow(() => assertPublicAddress('2606:4700:4700::1111'));
});

test('URL 检查拒绝内部地址、内嵌凭据和其他协议', () => {
  for (const url of ['http://localhost/', 'http://localhost./', 'http://service.local/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'https://user:password@example.com/', 'file:///etc/passwd']) {
    assert.throws(() => validateUrl(url));
  }
  assert.equal(validateUrl('https://github.com/#readme').href, 'https://github.com/');
});

test('API 凭据只能用于 HTTPS JSON', async () => {
  await assert.rejects(collect({ url: 'http://example.com/', format: 'json', tokenEnv: 'API_TOKEN' }), /HTTPS JSON/);
  await assert.rejects(collect({ url: 'https://example.com/', format: 'html', tokenEnv: 'API_TOKEN' }), /HTTPS JSON/);
  await assert.rejects(collect({ url: 'https://example.com/', format: 'json', tokenEnv: 'INVALID-NAME' }), /环境变量名称/);
});

test('输出目录检查创建项目内目录并拒绝越界与已有文件', async () => {
  await mkdir('work', { recursive: true });
  const root = await mkdtemp(path.resolve('work/collect-test-'));
  const destination = await resolveOutput('sources/new.json', root);
  await writeFile(destination, '{}\n', { flag: 'wx' });
  assert.equal(await readFile(destination, 'utf8'), '{}\n');
  await assert.rejects(resolveOutput('sources/new.json', root), /已经存在/);
  await assert.rejects(resolveOutput('../outside.json', root), /内部/);
  await assert.rejects(resolveOutput('source.txt', root), /\.json/);
});

test('输出目录检查拒绝指向项目外部的目录链接', async () => {
  await mkdir('work', { recursive: true });
  const root = await mkdtemp(path.resolve('work/collect-link-test-'));
  const outside = await mkdtemp(path.resolve('work/collect-outside-test-'));
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveOutput('linked/source.json', root), /普通目录/);
});

test('实际抓取 GitHub 的 HTML 与公开 JSON API', { skip: process.env.COLLECT_NETWORK_TEST !== '1', timeout: 70000 }, async () => {
  const html = await collect({ url: 'https://github.com/aliceyuruchan/womencareer-directory', format: 'html' });
  assert.equal(html.schemaVersion, 1);
  assert.match(html.title, /womencareer-directory/);
  assert.ok(html.text.includes('womencareer-directory'));
  assert.ok(html.links.length > 0);
  assert.ok(html.links.every((link) => /^https?:\/\//.test(link)));
  const json = await collect({ url: 'https://api.github.com/repos/aliceyuruchan/womencareer-directory', format: 'json' });
  assert.equal(json.data.full_name, 'aliceyuruchan/womencareer-directory');
  assert.equal(json.format, 'json');
});

test('实际抓取 GitHub Atom feed', { skip: process.env.COLLECT_NETWORK_TEST !== '1', timeout: 35000 }, async () => {
  const result = await collect({ url: 'https://github.com/aliceyuruchan/womencareer-directory/commits/main.atom', format: 'rss' });
  assert.match(result.title, /womencareer-directory/);
  assert.ok(result.links.some((link) => link.includes('/commit/')));
  assert.ok(result.data.feed);
});

test('实际来源体积限制与重定向检查', { skip: process.env.COLLECT_NETWORK_TEST !== '1', timeout: 70000 }, async () => {
  await assert.rejects(collect({ url: 'https://api.github.com/repos/aliceyuruchan/womencareer-directory', format: 'json', maxBytes: 100 }), /超过/);
  await assert.rejects(collect({ url: 'https://github.com/aliceyuruchan/womencareer-directory.git', format: 'html' }), /重定向/);
});
