import type { SiteConfig } from "../site/config";

/**
 * EDIT ME: the site's voice and positioning for the AI page agent's system prompt (prompt.ts).
 * This is neutral placeholder copy; replace each section with the real thing. Facts the agent may
 * state come from `get_site_context` (the llms.txt text, llms-intro.ts), not from here.
 *
 * Editing this text changes the cached prompt prefix: the first agent request after a deploy
 * writes a new cache entry, nothing else.
 */
export function positioning(config: Pick<SiteConfig, "name">): string {
  return `# ${config.name}: voice and positioning (EDIT ME)

## Who we are
Edit me: one paragraph on who ${config.name} is and who runs it.

## What we offer
Edit me: what the site's business or project offers, in plain words.

## Who it is for
- Edit me: the main audience.
- Edit me: a second audience.
Not for: Edit me: who should look elsewhere.

## The promise
Edit me: what a visitor or customer gets, concretely.

## Voice
- Plain, direct and honest. Short sentences.
- Concrete over abstract: numbers, times, what you get.
- No hype words, no em dashes, no "unlock", "leverage", "game-changer", "revolutionise", "in today's fast-paced world".
- Edit me: first person ("I") or "we", and the spelling variant to use.
`;
}
