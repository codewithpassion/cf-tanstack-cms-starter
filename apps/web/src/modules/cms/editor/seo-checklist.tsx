import type { CheckStatus, SeoCheck } from "@repo/cms-core/seo/checks";
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Info,
  TriangleAlert,
} from "lucide-react";

/** The SEO checklist (docs/cms-plan.md §3.9): failures, then warnings, then passes, notes and n/a. Warn-only at publish. */

const ORDER: CheckStatus[] = ["fail", "warn", "pass", "info", "na"];

const STATUS: Record<
  CheckStatus,
  { Icon: typeof CircleCheck; cls: string; label: string }
> = {
  fail: { Icon: CircleX, cls: "text-danger", label: "Fail" },
  warn: { Icon: TriangleAlert, cls: "text-amber-400", label: "Warning" },
  pass: { Icon: CircleCheck, cls: "text-emerald-400", label: "Pass" },
  info: { Icon: Info, cls: "text-sky-300", label: "Note" },
  na: { Icon: CircleMinus, cls: "text-neutral-500", label: "n/a" },
};

export function SeoChecklist({
  checks,
  score,
}: {
  checks: SeoCheck[];
  score: number;
}) {
  const sorted = [...checks].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)
  );
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return (
    <div className="flex flex-col gap-3 pt-1" data-testid="seo-checklist">
      <div className="flex items-center gap-3 rounded border border-neutral-800 bg-neutral-950 p-3">
        <div
          className="font-bold font-heading text-3xl text-white"
          data-testid="seo-checklist-score"
        >
          {score}
        </div>
        <div className="text-neutral-400 text-xs">
          <div>SEO score</div>
          <div>
            <span className="text-danger">{count("fail")} fail</span> ·{" "}
            <span className="text-amber-400">{count("warn")} warn</span> ·{" "}
            <span className="text-emerald-400">{count("pass")} pass</span>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-neutral-500">
        Checks never block publishing; fix what matters for this page.
      </p>
      <ul className="flex flex-col gap-1.5">
        {sorted.map((c) => {
          const { Icon, cls, label } = STATUS[c.status];
          return (
            <li
              className="flex gap-2 rounded bg-neutral-950/60 px-2 py-1.5"
              data-status={c.status}
              data-testid={`seo-check-${c.id}`}
              key={c.id}
            >
              <Icon
                aria-label={label}
                className={`mt-0.5 h-4 w-4 shrink-0 ${cls}`}
              />
              <div className="min-w-0 text-xs">
                <div className="font-medium text-neutral-200">{c.label}</div>
                <div className="break-words text-neutral-400">{c.message}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
