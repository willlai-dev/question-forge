import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 對外部 URL 的安全檢查（SSRF 防護，規格 §17）。
 *
 * 本系統優先使用 Tavily 的 `/extract`，正文由 Tavily 取回，
 * 我們原則上不會自己去打任意 URL —— 這本身就大幅縮小了 SSRF 的攻擊面。
 * 但搜尋結果的 URL 仍會被保存與顯示，且日後若加入直接抓取的路徑，
 * 這道檢查必須已經存在且被套用，而不是等到那時候才補。
 *
 * 檢查項目：
 *   - 只允許 http/https（擋掉 file:、gopher:、ftp: 等）
 *   - 擋掉 localhost 與各種等價寫法
 *   - DNS 解析後擋掉私有網段、loopback、link-local
 *   - 特別擋掉雲端 metadata 服務 169.254.169.254
 */

export interface UrlCheckResult {
  allowed: boolean;
  reason?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);

/** 不需要 DNS 的同步檢查。搜尋結果過濾用這個就夠，成本低。 */
export function checkUrlSyntactically(rawUrl: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: '不是合法的 URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `不支援的協定 ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: '指向本機' };
  }
  // .local / .internal 這類內網用網域
  if (/\.(local|internal|localdomain)$/.test(hostname)) {
    return { allowed: false, reason: '指向內部網域' };
  }

  if (isIP(hostname) && isBlockedIp(hostname)) {
    return { allowed: false, reason: '指向私有或保留位址' };
  }

  return { allowed: true };
}

/**
 * 含 DNS 解析的完整檢查。**任何真的要送出請求的地方都必須用這個。**
 *
 * 只做語法檢查不夠：攻擊者可以註冊一個解析到 127.0.0.1 或 169.254.169.254 的網域，
 * 語法上完全合法，解析後才看得出問題。
 */
export async function checkUrlBeforeFetch(rawUrl: string): Promise<UrlCheckResult> {
  const syntactic = checkUrlSyntactically(rawUrl);
  if (!syntactic.allowed) return syntactic;

  const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { allowed: true };

  try {
    const addresses = await lookup(hostname, { all: true });
    for (const address of addresses) {
      if (isBlockedIp(address.address)) {
        return { allowed: false, reason: `網域解析到受限位址（${address.address}）` };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: '無法解析網域' };
  }
}

/** 私有網段、loopback、link-local 與雲端 metadata 位址。 */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 私有
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // link-local，含 metadata 服務
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有
    if (a === 192 && b === 168) return true; // 私有
    if (a === 192 && b === 0) return true; // IETF 保留
    if (a >= 224) return true; // 多播與保留
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
    // IPv4-mapped（::ffff:127.0.0.1）要拆出內層位址再判斷
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }

  return true;
}
