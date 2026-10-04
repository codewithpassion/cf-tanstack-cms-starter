import { expect, test } from "bun:test";

import type { MediaInfo } from "@repo/services/cms/media-service";
import { appendPage } from "./media-list";

const item = (id: string, alt = id): MediaInfo =>
  ({
    id,
    alt,
    tags: [],
    mime: "image/png",
    url: `/media/${id}`,
  }) as unknown as MediaInfo;

test("appendPage adds the next page after the current items", () => {
  const out = appendPage([item("a"), item("b")], [item("c"), item("d")]);
  expect(out.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
});

test("appendPage skips ids already listed and keeps the listed copy", () => {
  const out = appendPage(
    [item("b", "edited"), item("a")],
    [item("b"), item("c")]
  );
  expect(out.map((m) => m.id)).toEqual(["b", "a", "c"]);
  expect(out[0]?.alt).toBe("edited");
});

test("appendPage drops repeats within one page", () => {
  expect(appendPage([], [item("x"), item("x")]).map((m) => m.id)).toEqual([
    "x",
  ]);
});
