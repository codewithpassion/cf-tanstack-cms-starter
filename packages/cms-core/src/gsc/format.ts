/** Number formats and verdict labels shared by the SEO tab's performance panel and /admin/seo. */

export const fmtInt = (v: number) => v.toLocaleString("en-AU");
export const fmtCtr = (v: number) => `${(v * 100).toFixed(1)}%`;
export const fmtPosition = (v: number | null) =>
  v === null ? "—" : v.toFixed(1);

/** URL Inspection verdicts in words, with a text colour. */
export function verdictLabel(verdict: string): { label: string; cls: string } {
  switch (verdict) {
    case "PASS":
      return { label: "Indexed", cls: "text-emerald-300" };
    case "PARTIAL":
      return { label: "Indexed, with issues", cls: "text-amber-300" };
    case "FAIL":
      return { label: "Error", cls: "text-danger" };
    case "NEUTRAL":
      return { label: "Not indexed", cls: "text-amber-300" };
    default:
      return { label: "Unknown", cls: "text-neutral-400" };
  }
}
