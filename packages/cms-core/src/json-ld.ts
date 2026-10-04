/**
 * Serialize an object for safe embedding in a <script type="application/ld+json">
 * via dangerouslySetInnerHTML. JSON.stringify does NOT escape `<`, `>` or `&`,
 * so a CMS-authored value like `</script>...` could break out of the script tag.
 * Escaping these to unicode keeps the JSON valid while neutralizing tag breakout.
 * U+2028/U+2029 are valid in JSON but illegal in inline-script JS, so escape too.
 */
const LINE_SEP = new RegExp(String.fromCharCode(0x20_28), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x20_29), "g");

export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}
