// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/style/useDestructuring: ported verbatim; kept as in the source.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: intentional no-op callbacks, as in the source.
// biome-ignore-all lint/suspicious/noReturnAssign: test clock helper, as in the source.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.
import { describe, expect, it } from "bun:test";

import { createBlock, getBlockDef } from "../blocks/registry";
import { applyOps } from "../ops/apply-ops";
import { mergeStyle, resolveResponsive } from "../style/vars";
import { sampleDoc } from "../test-fixtures";
import type { Block, BlockStyle, Device, PageDoc } from "../types";
import {
  AA_BODY,
  AA_LARGE,
  colorRgba,
  contrastRatio,
  displayValue,
  dragValue,
  effectiveFlat,
  effectiveResponsive,
  isLargeSize,
  keyStepValue,
  paddingDragOp,
  parseCssColor,
  rateContrast,
  resetFlatPatch,
  resetResponsivePatch,
  type StylePatch,
  setFlatPatch,
  setResponsivePatch,
  snap,
  stepDown,
  stepUp,
  styleOp,
  validateStylePatch,
} from "./style-model";

function heroBlock(): Block {
  return createBlock("hero", { _key: "b1" });
}

function docWith(block: Block): PageDoc {
  return { ...sampleDoc(), blocks: [block] };
}

const DEVICES: Device[] = ["desktop", "tablet", "mobile"];
const heroDefaults = getBlockDef("hero")!.defaultStyle; // padding desktop top 128 / bottom 80, align desktop center
const gridDefaults = getBlockDef("featureGrid")!.defaultStyle; // padding desktop 80/80, mobile 64/64

describe("effectiveResponsive: value + source per device", () => {
  it("desktop set → set here on desktop, inherited on tablet and mobile", () => {
    const own: BlockStyle = { padding: { desktop: { top: 96 } } };
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "desktop")
    ).toEqual({ value: 96, source: { kind: "here" } });
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "tablet")
    ).toEqual({
      value: 96,
      source: { kind: "inherited", from: "desktop" },
    });
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "mobile")
    ).toEqual({
      value: 96,
      source: { kind: "inherited", from: "desktop" },
    });
  });

  it("desktop 96 / mobile 48 → mobile set here, tablet inherits desktop", () => {
    const own: BlockStyle = {
      padding: { desktop: { top: 96 }, mobile: { top: 48 } },
    };
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "mobile")
    ).toEqual({ value: 48, source: { kind: "here" } });
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "tablet").value
    ).toBe(96);
  });

  it("nothing set anywhere → block default, from the device the default sets it on", () => {
    expect(
      effectiveResponsive({}, gridDefaults, "padding.top", "desktop")
    ).toEqual({
      value: 80,
      source: { kind: "default", from: "desktop" },
    });
    expect(
      effectiveResponsive(undefined, gridDefaults, "padding.top", "mobile")
    ).toEqual({
      value: 64,
      source: { kind: "default", from: "mobile" },
    });
  });

  it("a side set on a smaller device only → larger devices get the stylesheet base, not the block default", () => {
    // The renderer uses only the block's own values once any device sets the side.
    const own: BlockStyle = { padding: { mobile: { top: 48 } } };
    expect(
      effectiveResponsive(own, heroDefaults, "padding.top", "desktop")
    ).toEqual({ value: undefined, source: { kind: "base" } });
    expect(
      displayValue(
        effectiveResponsive<number>(
          own,
          heroDefaults,
          "padding.top",
          "desktop"
        ),
        "padding.top",
        "desktop"
      )
    ).toBe(0);
    // …per side: bottom still comes from the default.
    expect(
      effectiveResponsive(own, heroDefaults, "padding.bottom", "desktop").source
    ).toEqual({ kind: "default", from: "desktop" });
  });

  it("unset everywhere and no default → base literal (padding x 32/24/16)", () => {
    const eff = effectiveResponsive({}, heroDefaults, "padding.x", "tablet");
    expect(eff.source).toEqual({ kind: "base" });
    expect(
      DEVICES.map((d) =>
        displayValue(
          effectiveResponsive({}, heroDefaults, "padding.x", d),
          "padding.x",
          d
        )
      )
    ).toEqual([32, 24, 16]);
  });

  it("matches the renderer (mergeStyle + resolveResponsive) for every own/default combination", () => {
    const owns: (BlockStyle | undefined)[] = [
      undefined,
      {},
      { padding: { desktop: { top: 96 } } },
      { padding: { mobile: { top: 48 } } },
      { padding: { tablet: { top: 40, bottom: 8 } } },
      { padding: { desktop: { top: 96 }, mobile: { top: 48 } } },
      { padding: { desktop: { bottom: 12 } } },
    ];
    const defaults = [undefined, heroDefaults, gridDefaults];
    for (const own of owns) {
      for (const def of defaults) {
        for (const side of ["top", "bottom"] as const) {
          for (const d of DEVICES) {
            // cms.css resolves each var on its own: --cms-pt-m → -t → -d.
            const merged = mergeStyle(def, own).padding;
            const vars = Object.fromEntries(
              DEVICES.map((x) => [x, merged?.[x]?.[side]])
            );
            const rendered = resolveResponsive<number>(vars)[d];
            expect(
              effectiveResponsive(own, def, `padding.${side}`, d).value,
              JSON.stringify({ own, def, side, d })
            ).toBe(rendered);
          }
        }
      }
    }
  });

  it("hide cascades, and an explicit false un-hides a smaller device", () => {
    const own: BlockStyle = { hide: { tablet: true, mobile: false } };
    expect(effectiveResponsive(own, undefined, "hide", "desktop")).toEqual({
      value: undefined,
      source: { kind: "base" },
    });
    expect(effectiveResponsive(own, undefined, "hide", "tablet")).toEqual({
      value: true,
      source: { kind: "here" },
    });
    expect(effectiveResponsive(own, undefined, "hide", "mobile")).toEqual({
      value: false,
      source: { kind: "here" },
    });
    expect(
      effectiveResponsive(
        { hide: { tablet: true } },
        undefined,
        "hide",
        "mobile"
      )
    ).toEqual({
      value: true,
      source: { kind: "inherited", from: "tablet" },
    });
  });

  it("element properties use the element's own chain, then the definition's element default", () => {
    const own: BlockStyle = {
      elements: { heading: { size: { mobile: "lg" } } },
    };
    expect(
      effectiveResponsive(own, heroDefaults, "elements.heading.size", "mobile")
    ).toEqual({ value: "lg", source: { kind: "here" } });
    expect(
      effectiveResponsive(own, heroDefaults, "elements.heading.size", "desktop")
        .source
    ).toEqual({ kind: "base" });
    expect(
      effectiveResponsive(
        undefined,
        { elements: { lead: { align: { desktop: "center" } } } },
        "elements.lead.align",
        "tablet"
      )
    ).toEqual({
      value: "center",
      source: { kind: "default", from: "desktop" },
    });
  });
});

describe("effectiveFlat", () => {
  it("own value, else block default, else base", () => {
    const def: BlockStyle = { background: { gradient: "dark" } };
    expect(
      effectiveFlat(
        { background: { color: { token: "white" } } },
        def,
        "background.color"
      )
    ).toEqual({
      value: { token: "white" },
      source: { kind: "here" },
    });
    expect(effectiveFlat({}, def, "background.gradient")).toEqual({
      value: "dark",
      source: { kind: "default" },
    });
    expect(effectiveFlat({}, def, "border")).toEqual({
      value: undefined,
      source: { kind: "base" },
    });
  });
});

describe("patches", () => {
  it("set writes the current device only", () => {
    expect(setResponsivePatch("padding.top", "mobile", 48)).toEqual({
      padding: { mobile: { top: 48 } },
    });
    expect(setResponsivePatch("gap", "tablet", 16)).toEqual({
      gap: { tablet: 16 },
    });
    expect(
      setResponsivePatch("elements.heading.size", "desktop", "xl")
    ).toEqual({ elements: { heading: { size: { desktop: "xl" } } } });
    expect(setFlatPatch("colors.text", { hex: "#ffffff" })).toEqual({
      colors: { text: { hex: "#ffffff" } },
    });
    expect(setFlatPatch("elements.lead.color", undefined)).toEqual({
      elements: { lead: { color: null } },
    });
  });

  it("reset deletes the device value and prunes what it leaves empty", () => {
    const style: BlockStyle = {
      padding: { desktop: { top: 96, bottom: 80 }, mobile: { top: 48 } },
      hide: { tablet: true },
    };
    expect(resetResponsivePatch(style, "padding.top", "mobile")).toEqual({
      padding: { mobile: null },
    });
    expect(resetResponsivePatch(style, "padding.top", "desktop")).toEqual({
      padding: { desktop: { top: null } },
    });
    expect(resetResponsivePatch(style, "hide", "tablet")).toEqual({
      hide: null,
    });
    expect(resetResponsivePatch(style, "padding.top", "tablet")).toBeNull();
    expect(
      resetFlatPatch(
        { colors: { text: { token: "white" }, heading: { token: "white" } } },
        "colors.text"
      )
    ).toEqual({
      colors: { text: null },
    });
  });

  it("reset on mobile falls back to desktop; reset on desktop alone falls back to the block default", () => {
    let style: BlockStyle | undefined = {
      padding: { desktop: { top: 96 }, mobile: { top: 48 } },
    };
    const apply = (p: StylePatch | null) => {
      const block = applyOps(docWith({ ...heroBlock(), style }), [
        styleOp("b1", p!),
      ]).doc.blocks[0]!;
      style = block.style;
    };
    apply(resetResponsivePatch(style, "padding.top", "mobile"));
    expect(
      effectiveResponsive(style, heroDefaults, "padding.top", "mobile")
    ).toEqual({
      value: 96,
      source: { kind: "inherited", from: "desktop" },
    });
    apply(resetResponsivePatch(style, "padding.top", "desktop"));
    expect(style).toBeUndefined();
    expect(
      effectiveResponsive(style, heroDefaults, "padding.top", "desktop")
    ).toEqual({
      value: 128,
      source: { kind: "default", from: "desktop" },
    });
  });

  it("reset on desktop while mobile is still set leaves desktop on the base literal", () => {
    const style: BlockStyle = {
      padding: { desktop: { top: 96 }, mobile: { top: 48 } },
    };
    const block = applyOps(docWith({ ...heroBlock(), style }), [
      styleOp("b1", resetResponsivePatch(style, "padding.top", "desktop")!),
    ]).doc.blocks[0]!;
    expect(
      effectiveResponsive(block.style, heroDefaults, "padding.top", "desktop")
        .source
    ).toEqual({ kind: "base" });
  });
});

describe("4px spacing grid", () => {
  it("snaps, steps from off-grid values to the next grid line, and clamps drags", () => {
    expect([snap(0), snap(1), snap(2), snap(6), snap(97)]).toEqual([
      0, 0, 4, 8, 96,
    ]);
    expect([stepUp(96), stepUp(30), stepUp(-3)]).toEqual([100, 32, 0]);
    expect([stepDown(96), stepDown(30), stepDown(1)]).toEqual([92, 28, 0]);
    expect(dragValue(96, 13)).toBe(108);
    expect(dragValue(96, -1)).toBe(96);
    expect(dragValue(8, -100)).toBe(0);
    expect(dragValue(500, 100)).toBe(512);
  });

  it("a drag commits one op on the current device, none when nothing changed", () => {
    const block = {
      ...heroBlock(),
      style: { padding: { desktop: { top: 96 } } },
    };
    expect(paddingDragOp(block, heroDefaults, "mobile", "top", 48)).toEqual(
      styleOp("b1", { padding: { mobile: { top: 48 } } })
    );
    expect(paddingDragOp(block, heroDefaults, "desktop", "top", 96)).toBeNull();
    // Same value but inherited: dragging back to it still pins it on this device.
    expect(paddingDragOp(block, heroDefaults, "tablet", "top", 96)).toEqual(
      styleOp("b1", { padding: { tablet: { top: 96 } } })
    );
  });
});

describe("validateStylePatch", () => {
  it("passes valid patches and explains schema failures", () => {
    const block = heroBlock();
    expect(
      validateStylePatch(
        block,
        setResponsivePatch("padding.top", "desktop", 96)
      )
    ).toBeNull();
    expect(
      validateStylePatch(
        block,
        setResponsivePatch("padding.top", "desktop", 600)
      )
    ).toBe("Use 512 or less");
    expect(
      validateStylePatch(block, setResponsivePatch("padding.x", "desktop", -4))
    ).toBe("Use 0 or more");
    expect(
      validateStylePatch(
        block,
        setResponsivePatch("padding.top", "desktop", 9.5)
      )
    ).toBe("Use a whole number");
    expect(
      validateStylePatch(block, setFlatPatch("colors.text", { hex: "#12345" }))
    ).toMatch(/hex colour/);
  });

  it("refuses element properties the block doesn't support", () => {
    // hero's headingAccent supports colour only.
    expect(
      validateStylePatch(
        heroBlock(),
        setResponsivePatch("elements.headingAccent.size", "desktop", "xl")
      )
    ).toMatch(/does not support "size"/);
    expect(
      validateStylePatch(
        heroBlock(),
        setFlatPatch("elements.nope.color", { token: "white" })
      )
    ).toMatch(/no styleable element/);
  });
});

describe("contrast", () => {
  it("computes WCAG ratios", () => {
    expect(
      contrastRatio(parseCssColor("#767676")!, parseCssColor("#fff")!)
    ).toBeCloseTo(4.54, 2);
    expect(
      contrastRatio(parseCssColor("#000")!, parseCssColor("#ffffff")!)
    ).toBeCloseTo(21, 5);
    expect(contrastRatio(parseCssColor("#fff")!, parseCssColor("#fff")!)).toBe(
      1
    );
  });

  it("resolves tokens from the theme (hsl) and hex with alpha", () => {
    expect(colorRgba({ token: "white" })).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
    const sky = colorRgba({ token: "accent" })!;
    expect([Math.round(sky.r), Math.round(sky.g), Math.round(sky.b)]).toEqual([
      2, 132, 199,
    ]); // #0284c7, sky-600
    expect(colorRgba({ hex: "#00000080" })!.a).toBeCloseTo(0.5, 2);
  });

  it("rates solid pairs against 4.5 (body) / 3 (large)", () => {
    const onWhite: BlockStyle = { background: { color: { token: "white" } } };
    const gray = rateContrast({ hex: "#767676" }, onWhite, false);
    expect(gray).toMatchObject({
      kind: "rated",
      threshold: AA_BODY,
      pass: true,
    });
    const cyan = rateContrast({ token: "accent" }, onWhite, false);
    expect(cyan).toMatchObject({ kind: "rated", pass: false });
    expect(rateContrast({ hex: "#949494" }, onWhite, true)).toMatchObject({
      threshold: AA_LARGE,
      pass: true,
    });
    expect(rateContrast({ hex: "#949494" }, onWhite, false)).toMatchObject({
      pass: false,
    });
    expect(
      rateContrast(
        { token: "white" },
        { background: { color: { token: "ink" } } },
        false
      )
    ).toMatchObject({ pass: true });
  });

  it("is unknown for anything but a solid pair", () => {
    const unknown = (
      fg: Parameters<typeof rateContrast>[0],
      merged: BlockStyle
    ) => rateContrast(fg, merged, false).kind;
    expect(unknown({ token: "white" }, {})).toBe("unknown");
    expect(
      unknown(undefined, { background: { color: { token: "white" } } })
    ).toBe("unknown");
    expect(
      unknown(
        { token: "white" },
        { background: { color: { token: "ink" }, gradient: "dark" } }
      )
    ).toBe("unknown");
    expect(
      unknown(
        { token: "white" },
        { background: { color: { token: "ink" }, gradient: "none" } }
      )
    ).toBe("rated");
    expect(
      unknown(
        { token: "white" },
        {
          background: {
            color: { token: "ink" },
            image: { mediaId: "x" },
          },
        }
      )
    ).toBe("unknown");
    expect(
      unknown(
        { token: "white" },
        { background: { color: { hex: "#000000cc" } } }
      )
    ).toBe("unknown");
    expect(
      unknown({ hex: "#ffffff80" }, { background: { color: { hex: "#000" } } })
    ).toBe("unknown");
  });

  it("is unknown for text on a translucent card, whatever the block background", () => {
    const solid: BlockStyle = {
      background: { color: { token: "ink" } },
    };
    expect(rateContrast({ token: "white" }, solid, false, true)).toEqual({
      kind: "unknown",
      reason: "Text on a translucent card",
    });
    expect(rateContrast({ token: "white" }, solid, false, false).kind).toBe(
      "rated"
    );
  });

  it("steps padding handles with the arrow keys: 4px to the next grid line, 16 with Shift, clamped", () => {
    expect(keyStepValue(30, "ArrowUp", false)).toBe(32);
    expect(keyStepValue(32, "ArrowRight", false)).toBe(36);
    expect(keyStepValue(30, "ArrowDown", false)).toBe(28);
    expect(keyStepValue(32, "ArrowUp", true)).toBe(48);
    expect(keyStepValue(8, "ArrowLeft", true)).toBe(0);
    expect(keyStepValue(510, "ArrowUp", true)).toBe(512);
    expect(keyStepValue(32, "Enter", false)).toBeNull();
  });

  it("treats only known sizes ≥24px as large", () => {
    expect([
      isLargeSize(undefined),
      isLargeSize("base"),
      isLargeSize("lg"),
      isLargeSize("2xl"),
    ]).toEqual([false, false, true, true]);
  });
});
