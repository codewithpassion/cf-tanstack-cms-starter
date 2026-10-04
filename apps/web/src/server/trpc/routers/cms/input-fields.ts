import { z } from "zod";

/**
 * Zod fields for the CMS admin routers, with the messages the hand-rolled input checks of the
 * original server functions used. The tRPC error formatter (init.ts) sends the first issue's
 * message, so these are what the editor shows.
 */

/** A string of at most `max` characters. */
export const str = (key: string, max = 2048) => {
  const error = `Expected "${key}" to be a string`;
  return z.string({ error }).max(max, { error });
};

/** A non-negative integer. */
export const int = (key: string) => {
  const error = `Expected "${key}" to be a whole number`;
  return z.number({ error }).int({ error }).min(0, { error });
};

export const bool = (key: string) =>
  z.boolean({ error: `Expected "${key}" to be true or false` });

/** The payload itself must be an object. */
export const obj = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape, { error: "Expected an object" });

export const MAX_TITLE_LENGTH = 200;

/** A page or post title: trimmed, at most MAX_TITLE_LENGTH characters. */
export const title = () =>
  str("title", 400)
    .trim()
    .max(MAX_TITLE_LENGTH, {
      error: `Expected "title" to be at most ${MAX_TITLE_LENGTH} characters`,
    });

/** As history-admin.ts `MAX_VERSION_LABEL`. */
const MAX_VERSION_LABEL = 80;
export const VERSION_LABEL_MESSAGE = `A version name needs 1–${MAX_VERSION_LABEL} characters`;

/** Whether a trimmed version name fits (1–80 characters). */
export const isVersionLabel = (label: string): boolean => {
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_VERSION_LABEL;
};

/** A history cursor: the offset a previous page's `nextCursor` gave (history-admin.ts accepts up to 9 digits). */
const CURSOR_RE = /^\d{1,9}$/;
export const cursor = (max: number) =>
  str("cursor", max).regex(CURSOR_RE, {
    error: 'Expected "cursor" to be a cursor from a previous page',
  });
