import { describe, expect, it } from 'vitest';

import { checkUrlSyntactically, isBlockedIp } from './url-guard';

/**
 * SSRF 防護（規格 §17）。
 *
 * 這些 URL 來自搜尋結果——也就是外部、可被投毒的來源，
 * 而系統接下來會把它們送去擷取。任何一條漏網都可能讓外部內容
 * 誘導伺服器去打內部網路或雲端 metadata 服務。
 */

describe('checkUrlSyntactically', () => {
  it.each([
    'https://law.moj.gov.tw/LawClass/LawAll.aspx',
    'http://example.com/page',
    'https://zh.wikipedia.org/wiki/x',
  ])('允許一般的外部網址：%s', (url) => {
    expect(checkUrlSyntactically(url).allowed).toBe(true);
  });

  it.each([
    ['file:///etc/passwd', '不支援的協定'],
    ['gopher://a.com', '不支援的協定'],
    ['ftp://a.com/x', '不支援的協定'],
    ['javascript:alert(1)', '不支援的協定'],
  ])('擋下非 http(s) 協定：%s', (url) => {
    expect(checkUrlSyntactically(url).allowed).toBe(false);
  });

  it.each([
    'http://localhost/admin',
    'http://localhost:4000/api/v1/auth/me',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://foo.internal/x',
    'http://bar.local/x',
  ])('擋下指向本機或內網的主機名稱：%s', (url) => {
    expect(checkUrlSyntactically(url).allowed).toBe(false);
  });

  it.each([
    'http://127.0.0.1:6379/',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
  ])('擋下私有與 loopback 位址：%s', (url) => {
    expect(checkUrlSyntactically(url).allowed).toBe(false);
  });

  it('**擋下雲端 metadata 服務**（169.254.169.254）', () => {
    // 這是 SSRF 最典型的目標：取得雲端主機的憑證。
    const result = checkUrlSyntactically('http://169.254.169.254/latest/meta-data/');
    expect(result.allowed).toBe(false);
  });

  it('不合法的 URL 被擋下而不是拋錯', () => {
    expect(checkUrlSyntactically('這不是網址').allowed).toBe(false);
    expect(checkUrlSyntactically('').allowed).toBe(false);
  });
});

describe('isBlockedIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', '私有 A'],
    ['172.16.5.5', '私有 B 下界'],
    ['172.31.255.255', '私有 B 上界'],
    ['192.168.0.1', '私有 C'],
    ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', '未指定'],
    ['224.0.0.1', '多播'],
  ])('擋下 %s（%s）', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '203.0.113.10', '172.15.0.1', '172.32.0.1'])(
    '允許公開位址 %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it('擋下 IPv6 loopback 與 link-local', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
  });

  it('**擋下用 IPv4-mapped 形式包裝的內部位址**', () => {
    // ::ffff:127.0.0.1 是繞過只看字面的檢查最常見的手法。
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('允許 IPv6 公開位址', () => {
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });

  it('不是 IP 的字串一律視為受限（保守作法）', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});
