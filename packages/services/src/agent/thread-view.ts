// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: ported verbatim; splitting would make the file harder to diff against the source.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; label, class and value choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: indexes the source code proves in range (this repo sets noUncheckedIndexedAccess, the source does not), plus assertions as in the source; type-only.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (model output, server results, stored rows), as in the source.

import type { BudgetStatus } from "@repo/cms-core/agent/budget-types";
import {
  addUsage,
  usageSummaryOf,
  ZERO_USAGE,
} from "@repo/cms-core/agent/cost";
import {
  type AgentModelOption,
  modelOffInfo,
} from "@repo/cms-core/agent/models";
import { DECISIONS_HEADER, RUNS_HEADER } from "@repo/cms-core/agent/prompt";
import { toolLabel } from "@repo/cms-core/agent/tool-defs";
import type {
  Changeset,
  CreatedPage,
  ModelOff,
  ThreadDetail,
  ThreadItem,
} from "@repo/cms-core/agent/types";
import { mediaUrl } from "@repo/cms-core/media";
import { type StoredMessage, type ThreadRow, threadModel } from "./store-port";
import { canContinue, continueSummary, threadFull } from "./thread-limits";
import { toolResultsOf, workersAiAssistant } from "./transcript";

/**
 * A stored transcript as the chat shows it (docs/cms-plan.md §4.4): the user's messages and images,
 * the agent's text and progress notes, one chip per tool call (with whether it worked, or that it
 * was interrupted), drafts it created, refusals and cut-off replies, and the thread's total usage
 * and spending caps. Context system messages, decision reports and tool payloads stay hidden.
 * Reads both transcript formats (server/transcript.ts); a Workers AI model's reasoning shows as a
 * collapsed progress note. Pure.
 */

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: { type?: string; ref?: string };
  from?: { model?: string };
  to?: { model?: string };
};

/** `models`: the agent models with availability; when given, a thread whose model is turned off says so (`modelOff`). */
export function threadDetail(
  thread: ThreadRow,
  messages: StoredMessage[],
  changesets: Changeset[],
  budget: BudgetStatus,
  models?: readonly AgentModelOption[]
): ThreadDetail {
  const items: ThreadItem[] = [];
  const tools = new Map<string, ThreadItem & { kind: "tool" }>();
  const model = threadModel(thread);
  const addTool = (id: string, name: string, input: unknown) => {
    const item: ThreadItem & { kind: "tool" } = {
      kind: "tool",
      id,
      name,
      label: toolLabel(name, input as Record<string, unknown>),
      ok: null,
    };
    tools.set(id, item);
    items.push(item);
  };
  let usage = ZERO_USAGE;
  let costUsd = 0;
  for (const m of messages) {
    const blocks: Block[] =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? (m.content as Block[])
          : [];
    if (m.role === "system") {
      continue;
    }
    if (m.role === "user" || m.role === "tool") {
      const results = toolResultsOf(m);
      for (const r of results) {
        const tool = tools.get(r.callId);
        if (!tool) {
          continue;
        }
        tool.ok = !r.isError;
        if (r.isError) {
          tool.summary = resultText(r.content).slice(0, 200);
        }
        const created =
          tool.name === "create_page" && !r.isError
            ? createdFrom(r.content)
            : null;
        if (created) {
          items.push({
            kind: "created",
            id: `${tool.id}:created`,
            page: created,
          });
        }
      }
      if (results.length || m.role === "tool") {
        continue;
      }
      const text = blocks
        .filter(
          (b) =>
            b.type === "text" &&
            !b.text?.startsWith(DECISIONS_HEADER) &&
            !b.text?.startsWith(RUNS_HEADER)
        )
        .map((b) => b.text ?? "")
        .join("\n")
        .replace(/\n\n\[Attached images[^\]]*\]$/, "");
      const images = blocks.flatMap((b) =>
        b.type === "image" && b.source?.ref?.startsWith("media:")
          ? [mediaUrl(b.source.ref.slice(6))]
          : []
      );
      items.push({ kind: "user", id: `${m.seq}`, text, images });
      continue;
    }
    // Assistant.
    const fallback = !!m.model && m.model !== model.id;
    const wai = workersAiAssistant(m);
    const cutOff =
      m.stopReason === "refusal" ||
      m.stopReason === "max_tokens" ||
      m.stopReason === "length" ||
      m.stopReason === "content_filter";
    if (wai) {
      if (wai.reasoning_content?.trim()) {
        items.push({
          kind: "progress",
          id: `${m.seq}:reasoning`,
          text: wai.reasoning_content.trim(),
          reasoning: true,
        });
      }
      if (wai.content?.trim()) {
        items.push({
          kind: "text",
          id: `${m.seq}:text`,
          text: wai.content,
          ...(m.model && { model: m.model }),
          ...(cutOff && { partial: true }),
        });
      }
      for (const c of wai.tool_calls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = undefined;
        }
        addTool(c.id, c.function.name, input);
      }
    }
    blocks.forEach((b, i) => {
      const id = `${m.seq}:${i}`;
      if (b.type === "thinking" && b.thinking?.trim()) {
        items.push({ kind: "progress", id, text: b.thinking.trim() });
      } else if (b.type === "text" && b.text?.trim()) {
        items.push({
          kind: "text",
          id,
          text: b.text,
          ...(m.model && { model: m.model }),
          ...(fallback && { fallback: true }),
          ...(cutOff && { partial: true }),
        });
      } else if (b.type === "tool_use" && b.id && b.name) {
        addTool(b.id, b.name, b.input);
      } else if (b.type === "fallback") {
        items.push({
          kind: "notice",
          id,
          text: `${b.from?.model ?? "The model"} declined; ${b.to?.model ?? "a fallback model"} answered.`,
        });
      }
    });
    if (m.stopReason === "refusal" || m.stopReason === "content_filter") {
      items.push({ kind: "refusal", id: `${m.seq}:refusal`, category: null });
    }
    if (m.stopReason === "max_tokens" || m.stopReason === "length") {
      items.push({
        kind: "notice",
        id: `${m.seq}:max`,
        text: "The reply hit the output limit and may be cut off.",
      });
    }
    if (m.usage) {
      usage = addUsage(usage, usageSummaryOf(m.usage, m.model ?? model.id));
    }
    costUsd += m.costUsd ?? 0;
  }
  // A call without a result never ran to the end (Stop, or the request ended); the next turn answers it as interrupted.
  for (const t of tools.values()) {
    if (t.ok !== null) {
      continue;
    }
    t.ok = false;
    t.interrupted = true;
    t.summary = "Interrupted";
  }
  return {
    thread: {
      id: thread.id,
      pageId: thread.pageId,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      provider: model.provider,
      model: model.id,
      // The budget's figure also counts calls that stored nothing (stopped, failed, retried).
      costUsd: budget.thread?.spentUsd ?? costUsd,
    },
    items,
    changesets,
    usage,
    budget,
    full: threadFull(thread.title, messages, changesets),
    modelOff: models
      ? threadModelOff(thread, messages, changesets, models)
      : null,
    canContinue: canContinue(messages),
  };
}

/** Why the thread's model can't take new messages (turned off or removed), with a summary to start the next thread with. */
export function threadModelOff(
  thread: ThreadRow,
  messages: StoredMessage[],
  changesets: Changeset[],
  models: readonly AgentModelOption[]
): ModelOff | null {
  const off = modelOffInfo(models, threadModel(thread));
  return (
    off && {
      ...off,
      summary: continueSummary(thread.title, messages, changesets),
    }
  );
}

/** The new draft from a create_page result. */
function createdFrom(content: unknown): CreatedPage | null {
  try {
    const r = JSON.parse(typeof content === "string" ? content : "") as {
      ok?: boolean;
      id?: string;
      slug?: string;
      title?: string;
      editorUrl?: string;
    };
    if (!(r.ok && r.id) || typeof r.slug !== "string" || !r.editorUrl) {
      return null;
    }
    return {
      id: r.id,
      kind: r.slug.startsWith("blog/") ? "post" : "page",
      slug: r.slug,
      title: r.title ?? "",
      editorUrl: r.editorUrl,
    };
  } catch {
    return null;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as {
        errors?: { code: string; message: string }[];
      };
      if (parsed.errors?.length) {
        return `${parsed.errors[0]!.code}: ${parsed.errors[0]!.message}`;
      }
    } catch {
      // Plain text.
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((c) => (c as Block).text ?? "").join(" ");
  }
  return "";
}
