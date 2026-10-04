/**
 * The link rule (Zod-free): the renderers check hrefs at render time with this, and the link
 * schemas in links.ts validate with it on save.
 */

const ALLOWED_PROTOCOLS = new Set(["https:", "mailto:", "tel:"]);

/**
 * Allowed: root-relative paths ("/contact"), fragments ("#faq"), queries ("?x=1"),
 * and https:, mailto:, tel: URLs. Rejects protocol-relative ("//host"), backslashes
 * (browsers treat "/\host" as "//host"), control characters and surrounding whitespace.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (they are rejected).
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f\\]/;

export function isSafeHref(href: string): boolean {
  if (href === "" || href !== href.trim()) {
    return false;
  }
  if (UNSAFE_CHARS_RE.test(href)) {
    return false;
  }
  if (href.startsWith("/")) {
    return !href.startsWith("//");
  }
  if (href.startsWith("#") || href.startsWith("?")) {
    return true;
  }
  try {
    const url = new URL(href);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return false;
    }
    return url.protocol !== "https:" || url.hostname !== "";
  } catch {
    return false;
  }
}
