/**
 * Validate that a URL is safe to forward to the CF Browser Rendering API.
 * Only allows http: and https: schemes to prevent SSRF via file:/data:/etc.
 *
 * Note on DNS rebinding: for REST API routes the actual fetch is performed by
 * Cloudflare's infrastructure, not by this Worker.  We validate the URL
 * statically here; Puppeteer routes additionally intercept every sub-request
 * via `page.setRequestInterception` for runtime SSRF protection.
 */

export type UrlValidationResult = { valid: true } | { valid: false; error: string };

// Block private/internal targets to prevent SSRF
// URL.hostname keeps brackets for IPv6: http://[::1]/ → "[::1]"
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "0.0.0.0",
]);

const PRIVATE_IP_ERROR = "URL targets a private IP address";
const PRIVATE_HOST_ERROR = "URL targets a blocked host";
const PRIVATE_DNS_ERROR = "URL hostname resolves to a private IP address";
const DNS_LOOKUP_ERROR = "Unable to validate URL hostname resolution";
const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 3_000;

function isIpv4Literal(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isIpv6Literal(host: string): boolean {
  return host.startsWith("[") && host.endsWith("]");
}

function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || isIpv6Literal(host);
}

function isPrivateIpLiteral(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) {
    return true;
  }

  if (isIpv4Literal(host)) {
    // Block private IP ranges:
    //   0.x, 10.x, 127.x (loopback), 172.16-31.x, 192.168.x,
    //   169.254.x (link-local)
    //   100.64-127.x (CGNAT / RFC 6598)
    return /^(0\.|10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host
    );
  }

  const bare = host.replace(/^\[|\]$/g, "");
  return (
    /^(fc|fd|fe[89a-f])/i.test(bare) || // ULA (fc00::/7) + link-local (fe80::/10) + site-local (fec0::/10)
    /^::ffff:/i.test(bare) || // IPv4-mapped IPv6 (::ffff:0:0/96)
    /^64:ff9b:/i.test(bare) || // NAT64 prefixes (64:ff9b::/96 + 64:ff9b:1::/48)
    /^[0:]+$/.test(bare)
  ); // unspecified address (::, ::0, 0:0:0:0:0:0:0:0, etc.)
}

function validateParsedUrl(parsed: URL): UrlValidationResult {
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: "Only http and https URLs are supported" };
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    return { valid: false, error: PRIVATE_HOST_ERROR };
  }

  if (isPrivateIpLiteral(parsed.hostname)) {
    return { valid: false, error: PRIVATE_IP_ERROR };
  }

  return { valid: true };
}

/**
 * Process-wide resolution cache.
 *
 * Without this, every validated request paid two fresh DoH round-trips before
 * any real work started — the per-call `new Map()` default meant the cache was
 * born empty and thrown away on each call. Entries are held for
 * `DNS_CACHE_TTL_MS`, which keeps a rebinding window far shorter than the
 * lifetime of a hot Worker isolate.
 */
const globalDnsCache = new Map<string, { at: number; lookup: Promise<string[]> }>();
const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX_ENTRIES = 1_000;

function getGlobalCached(key: string): Promise<string[]> | undefined {
  const entry = globalDnsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > DNS_CACHE_TTL_MS) {
    globalDnsCache.delete(key);
    return undefined;
  }
  return entry.lookup;
}

function setGlobalCached(key: string, lookup: Promise<string[]>): void {
  // Crude bound: an isolate serving many hosts should not grow without limit.
  if (globalDnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
    globalDnsCache.clear();
  }
  globalDnsCache.set(key, { at: Date.now(), lookup });
}

async function resolveHostname(
  hostname: string,
  cache?: Map<string, Promise<string[]>>,
): Promise<string[]> {
  const cacheKey = hostname.toLowerCase();

  // A caller-supplied cache (the puppeteer request interceptor) is scoped to a
  // single page load and takes precedence; otherwise use the shared one.
  const cached = cache?.get(cacheKey) ?? getGlobalCached(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = (async () => {
    const recordTypes = ["A", "AAAA"];
    const settled = await Promise.all(
      recordTypes.map(async (type) => {
        const params = new URLSearchParams({ name: hostname, type });
        const response = await fetch(`${DNS_ENDPOINT}?${params.toString()}`, {
          headers: { Accept: "application/dns-json" },
          signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(`DNS lookup failed with HTTP ${response.status}`);
        }

        const payload = await response.json<{
          Answer?: Array<{ data?: unknown }>;
        }>();

        return (payload.Answer ?? [])
          .map((answer) => answer.data)
          .filter((answer): answer is string => typeof answer === "string");
      }),
    );

    return settled.flat();
  })();

  // A failed lookup must not be cached: a transient DoH error would otherwise
  // block the host until the entry expired.
  const shared = lookup.catch((err) => {
    if (cache?.get(cacheKey) === shared) cache.delete(cacheKey);
    if (getGlobalCached(cacheKey) === shared) globalDnsCache.delete(cacheKey);
    throw err;
  });

  cache?.set(cacheKey, shared);
  setGlobalCached(cacheKey, shared);
  return shared;
}

export function validateUrl(url: string): UrlValidationResult {
  try {
    const parsed = new URL(url);
    return validateParsedUrl(parsed);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

export async function validateUrlWithDns(
  url: string,
  cache?: Map<string, Promise<string[]>>,
): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  const staticCheck = validateParsedUrl(parsed);
  if (!staticCheck.valid) {
    return staticCheck;
  }

  if (isIpLiteral(parsed.hostname)) {
    return staticCheck;
  }

  try {
    const answers = await resolveHostname(parsed.hostname, cache);
    if (answers.some((answer) => isPrivateIpLiteral(answer))) {
      return { valid: false, error: PRIVATE_DNS_ERROR };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: DNS_LOOKUP_ERROR };
  }
}
