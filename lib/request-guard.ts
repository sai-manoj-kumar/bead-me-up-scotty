/**
 * Cross-site request guard for the local server (used by proxy.ts).
 *
 * Beadscope listens on a predictable localhost port and can write beads, register
 * project folders and run the self-updater. Two browser attacks reach such a
 * server from an ordinary web page:
 *
 * - Cross-site writes (CSRF): a page POSTs to http://localhost:<port>/api/...
 *   with a "simple" content type, which skips the CORS preflight. Browsers
 *   always attach an Origin header to such requests, so a write whose Origin
 *   differs from the addressed Host is refused.
 * - DNS rebinding: an attacker's hostname re-resolves to 127.0.0.1, making the
 *   page same-origin with Beadscope, so it could read responses too. The browser
 *   still sends the attacker's name in Host, so only names that cannot be
 *   rebound are answered: localhost, *.localhost and IP literals. Anything
 *   else (a LAN hostname, a reverse-proxy domain) is opt-in through
 *   BEADSCOPE_ALLOWED_HOSTS.
 *
 * Non-browser clients (the launcher, curl, scripts) send no Origin and are
 * unaffected. Kept free of imports so scripts/test-request-guard.mjs can load it
 * directly.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type GuardInput = {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** Comma-separated BEADSCOPE_ALLOWED_HOSTS value; "*" disables the Host check. */
  allowedHosts?: string;
};

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: "host_not_allowed" | "cross_origin"; error: string };

/** Hostname of a Host header / URL authority, lowercased, without port or brackets. */
export function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    return a.slice(1, end === -1 ? undefined : end);
  }
  const colon = a.lastIndexOf(":");
  const name = colon === -1 ? a : a.slice(0, colon);
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function allowList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((h) => hostnameOf(h)).filter(Boolean);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpLiteral(name: string): boolean {
  const m = IPV4.exec(name);
  if (m) return m.slice(1).every((part) => Number(part) <= 255);
  // Bracketed IPv6 in a Host header; hostnameOf strips the brackets.
  return name.includes(":") && /^[0-9a-f:.]+$/.test(name);
}

/** Whether a Host value names this machine in a way DNS rebinding cannot forge. */
export function isAllowedHost(host: string | null, allowedHosts?: string): boolean {
  // HTTP/1.1 clients always send Host; a client without one is not a browser.
  if (!host) return true;
  const list = allowList(allowedHosts);
  if (list.includes("*")) return true;
  const name = hostnameOf(host);
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (isIpLiteral(name)) return true;
  return list.includes(name);
}

export function checkRequest(input: GuardInput): GuardVerdict {
  const { method, host, origin, secFetchSite, allowedHosts } = input;
  if (!isAllowedHost(host, allowedHosts)) {
    const name = hostnameOf(host ?? "");
    return {
      ok: false,
      code: "host_not_allowed",
      error: `Beadscope only answers requests addressed to localhost or an IP address. ` +
        `To open it as "${name}", start it with BEADSCOPE_ALLOWED_HOSTS=${name} ` +
        `(or BEADSCOPE_ALLOWED_HOSTS=* to accept any hostname).`,
    };
  }
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  if (origin) {
    let originHost: string | null = null;
    try {
      // "null" (sandboxed frames, file: pages) is not a URL and is refused.
      originHost = new URL(origin).host.toLowerCase();
    } catch { /* refused below */ }
    const sameHost = originHost !== null && host !== null && originHost === host.toLowerCase();
    // A reverse proxy may rewrite Host; an explicitly allowed origin name still
    // counts. "*" deliberately does not: it relaxes the Host check only, so
    // "accept any hostname" never turns into "accept writes from any website".
    const allowedOrigin = originHost !== null && allowList(allowedHosts).includes(hostnameOf(originHost));
    if (!sameHost && !allowedOrigin) {
      const name = originHost === null ? null : hostnameOf(originHost);
      return {
        ok: false,
        code: "cross_origin",
        error: name
          ? `Refused a change sent from ${name}, which is not this Beadscope's address. If you open Beadscope through ` +
            `${name} (for example a reverse proxy), start it with BEADSCOPE_ALLOWED_HOSTS=${name}.`
          : "Refused a change sent from a sandboxed or local page (no web address).",
      };
    }
    return { ok: true };
  }
  // Browsers that omit Origin still label cross-site requests.
  if (secFetchSite === "cross-site") {
    return { ok: false, code: "cross_origin", error: "Refused a change sent from another website." };
  }
  return { ok: true };
}
