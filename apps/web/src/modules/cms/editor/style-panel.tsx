// biome-ignore-all lint/a11y/noLabelWithoutControl: the label wraps the Radix Switch (a button) it names.
// biome-ignore-all lint/a11y/useSemanticElements: a role="group" of toggle buttons, as in the source; a fieldset would add its own styling.
// biome-ignore-all lint/correctness/useExhaustiveDependencies: effects deliberately depend on a subset (callbacks read through refs, run-once setup), as in the source.
// biome-ignore-all lint/performance/noJsxPropsBind: ported verbatim from the source editor; inline handlers keep it diffable and these admin-only panels are not render-hot.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim; none of these regexes run in a hot loop.
// biome-ignore-all lint/style/noNestedTernary: ported verbatim; class-name and label choices kept as in the source.
// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: defensive checks on data the types do not fully describe (server results, unvalidated docs, DOM lookups), as in the source.

import {
  type ContrastRating,
  DEVICE_LABEL,
  displayValue,
  type Effective,
  effectiveFlat,
  effectiveResponsive,
  type FlatPath,
  isLargeSize,
  type ResponsivePath,
  rateContrast,
  resetFlatPatch,
  resetResponsivePatch,
  SPACING_RANGE,
  type StylePatch,
  setColorPatch,
  setFlatPatch,
  setResponsivePatch,
  solidBackground,
  sourceLabel,
  stepDown,
  stepUp,
  styleOp,
  validateStylePatch,
} from "@repo/cms-core/editor/style-model";
import { HEX_RE } from "@repo/cms-core/style/schema";
import { DEVICES, mergeStyle } from "@repo/cms-core/style/vars";
import {
  type Block,
  type BlockStyle,
  BRAND_TOKENS,
  type Color,
  type Device,
  type GradientPreset,
  type TextSize,
} from "@repo/cms-core/types";
import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Switch } from "#/components/ui/switch";
import { getBlock } from "../blocks/registry";
import { ImageField } from "./media-library";
import { setShowHiddenBlocks, useShowHiddenBlocks } from "./style-canvas";
import { SwatchesContext } from "./swatches";
import { useEditorStore } from "./use-editor-store";

/**
 * Inspector → Style for the selected block and its declared elements.
 * Follows the editor's device: responsive values are read and written for that device, each with
 * where it comes from (set here, inherited, block default, not set). Every change is validated as
 * the store will validate it before it's applied; a refusal shows at the control.
 */

type Ctx = {
  block: Block;
  defaults: BlockStyle | undefined;
  merged: BlockStyle;
  device: Device;
  /** Validates and applies; a refusal shows at control `id`. Returns whether it was applied. */
  commit: (id: string, patch: StylePatch | null) => boolean;
  /** Drops the refusal shown at control `id`. */
  clearError: (id: string) => void;
  errors: Record<string, string | null>;
};

const StyleCtx = createContext<Ctx | null>(null);
const useCtx = () => useContext(StyleCtx)!;

export function StylePanel({
  block,
  device,
}: {
  block: Block;
  device: Device;
}) {
  const store = useEditorStore();
  const def = getBlock(block._type);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  // Any change to the block's style (undo, redo, reset, another control) settles what the refusals
  // were about: they describe values that were never applied.
  useEffect(() => setErrors({}), [block.style]);
  if (!def) {
    return (
      <p className="p-2 text-sm text-destructive">
        Unknown block type "{block._type}".
      </p>
    );
  }
  const defaults = def.defaultStyle;

  const commit: Ctx["commit"] = (id, patch) => {
    if (!patch) {
      return true;
    }
    // Always the latest block, not the one this render closed over.
    const current = store
      .getSnapshot()
      .doc.blocks.find((b) => b._key === block._key);
    let error: string | null = current
      ? validateStylePatch(current, patch)
      : "This block was removed";
    if (!error) {
      const res = store.apply([styleOp(block._key, patch)]);
      error = res.ok
        ? null
        : (res.errors[0]?.message ?? "That change couldn't be made");
    }
    setErrors((e) => ({ ...e, [id]: error }));
    return error === null;
  };
  const clearError = (id: string) =>
    setErrors((e) => (e[id] ? { ...e, [id]: null } : e));

  const ctx: Ctx = {
    block,
    defaults,
    merged: mergeStyle(defaults, block.style),
    device,
    commit,
    clearError,
    errors,
  };
  const elementNames = Object.keys(def.elements);
  // Some of the block's text sits on translucent cards: block colours can't be rated.
  const onCard = (def.onCard?.length ?? 0) > 0;

  return (
    <StyleCtx.Provider value={ctx}>
      <div
        className="flex flex-col gap-4 pt-2"
        data-testid="style-panel"
        data-device={device}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <def.Icon className="h-4 w-4 text-primary" /> {def.label}
        </div>
        <p
          className="rounded bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="style-device"
        >
          Editing{" "}
          <strong className="text-primary">{DEVICE_LABEL[device]}</strong>.
          Values cascade Desktop → Tablet → Mobile; a smaller device inherits
          until you set it there.
        </p>

        <Section title="Visibility">
          <VisibilityControl />
        </Section>

        <Section title="Spacing" hint="px, 4px steps">
          <SpacingControl label="Padding top" path="padding.top" />
          <SpacingControl label="Padding bottom" path="padding.bottom" />
          <SpacingControl label="Padding sides" path="padding.x" />
          <SpacingControl label="Margin top" path="margin.top" />
          <SpacingControl label="Margin bottom" path="margin.bottom" />
          <SpacingControl label="Gap" path="gap" />
        </Section>

        <Section title="Layout">
          <ResponsiveSelect
            label="Max width"
            path="maxWidth"
            options={[
              ["narrow", "Narrow (896px)"],
              ["default", "Default (1280px)"],
              ["wide", "Wide (1536px)"],
              ["full", "Full width"],
            ]}
          />
          <AlignControl label="Align" path="align" />
        </Section>

        <Section title="Background" hint="all devices">
          <BackgroundControls />
        </Section>

        <Section title="Colours" hint="all devices">
          {/* Block colours reach every heading and text of the block, whatever its size: rated as body text (4.5:1). */}
          <ColorRow
            label="Text"
            path="colors.text"
            contrast={(fg, merged) => rateContrast(fg, merged, false, onCard)}
          />
          <ColorRow
            label="Headings"
            path="colors.heading"
            contrast={(fg, merged) => rateContrast(fg, merged, false, onCard)}
          />
          <ColorRow
            label="Accent"
            path="colors.accent"
            contrast={(fg, merged) => rateContrast(fg, merged, false, onCard)}
          />
        </Section>

        <Section title="Border" hint="card surfaces, all devices">
          <FlatSegmented
            label="Style"
            path="border"
            options={[
              ["none", "None"],
              ["glow", "Glow"],
              ["subtle", "Subtle"],
            ]}
          />
        </Section>

        {elementNames.length > 0 && (
          <Section title="Elements">
            {elementNames.map((name) => (
              <ElementControls
                key={name}
                name={name}
                props={def.elements[name]!}
                onCard={def.onCard?.includes(name) ?? false}
              />
            ))}
          </Section>
        )}
      </div>
    </StyleCtx.Provider>
  );
}

// --- layout pieces ---------------------------------------------------------------------------------

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-3"
      data-testid={`style-section-${title.toLowerCase()}`}
    >
      <h3 className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {!!hint && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

/** Label, source note (dot + Reset when set here), the control and its error. */
function Row({
  id,
  label,
  source,
  onReset,
  children,
}: {
  id: string;
  label: string;
  source: Effective<unknown>["source"];
  onReset?: () => void;
  children: ReactNode;
}) {
  const { errors, device } = useCtx();
  const here = source.kind === "here";
  const error = errors[id];
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`style-row-${id}`}
      data-source={source.kind}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {here && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            aria-hidden
            data-testid="set-dot"
          />
        )}
        <span className="font-medium text-muted-foreground">{label}</span>
        <span
          className="ml-auto truncate text-muted-foreground"
          data-testid="style-source"
        >
          {here && onReset
            ? `Set on ${DEVICE_LABEL[device]}`
            : sourceLabel(source)}
        </span>
        {!!here && onReset && (
          <button
            type="button"
            title="Reset: inherit again"
            aria-label={`Reset ${label}`}
            data-testid={`reset-${id}`}
            onClick={onReset}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
      {children}
      {!!error && (
        <p
          className="text-xs text-destructive"
          role="alert"
          data-testid="style-error"
        >
          {error}
          <span className="block text-muted-foreground">Not applied.</span>
        </p>
      )}
    </div>
  );
}

/** Flat properties: "Set" with Reset, block default, or not set. */
function FlatRow({
  id,
  label,
  path,
  children,
}: {
  id: string;
  label: string;
  path: FlatPath;
  children: ReactNode;
}) {
  const { block, defaults, commit } = useCtx();
  const eff = effectiveFlat(block.style, defaults, path);
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`style-row-${id}`}
      data-source={eff.source.kind}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {eff.source.kind === "here" && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            aria-hidden
            data-testid="set-dot"
          />
        )}
        <span className="font-medium text-muted-foreground">{label}</span>
        <span
          className="ml-auto truncate text-muted-foreground"
          data-testid="style-source"
        >
          {eff.source.kind === "here" ? "Set" : sourceLabel(eff.source)}
        </span>
        {eff.source.kind === "here" && (
          <button
            type="button"
            title="Reset"
            aria-label={`Reset ${label}`}
            data-testid={`reset-${id}`}
            onClick={() => commit(id, resetFlatPatch(block.style, path))}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
      {children}
      <ErrorText id={id} />
    </div>
  );
}

function ErrorText({ id }: { id: string }) {
  const error = useCtx().errors[id];
  if (!error) {
    return null;
  }
  return (
    <p
      className="text-xs text-destructive"
      role="alert"
      data-testid="style-error"
    >
      {error}
      <span className="block text-muted-foreground">Not applied.</span>
    </p>
  );
}

const inputClass =
  "w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none aria-[invalid=true]:border-destructive";

function useResponsive<T>(path: ResponsivePath) {
  const { block, defaults, device, commit, clearError } = useCtx();
  const eff = effectiveResponsive<T>(block.style, defaults, path, device);
  const id = path.replaceAll(".", "-");
  return {
    id,
    eff,
    value: displayValue(eff, path, device),
    set: (v: T) => commit(id, setResponsivePatch(path, device, v)),
    reset: () => commit(id, resetResponsivePatch(block.style, path, device)),
    clearError: () => clearError(id),
  };
}

/** Typing pauses this long before a value that parses is tried. */
const TYPING_COMMIT_MS = 400;

/**
 * A text input over an applied value: keystrokes stay local; `commit` (which applies, or shows a
 * refusal and returns false) runs on Enter, on blur, and after a pause in typing when `ready` says
 * the text is complete. Blur ends the edit: the input shows the applied value again and a refusal
 * is cleared. A change from elsewhere (undo, reset, the steppers) replaces the text when it isn't
 * being edited.
 */
function useCommittedText(
  applied: string,
  commit: (text: string) => boolean,
  ready: (text: string) => boolean,
  clearError: () => void
) {
  const [text, setText] = useState(applied);
  const [editing, setEditing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ commit, ready });
  latest.current = { commit, ready };
  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = null;
  };
  useEffect(() => {
    if (!editing) {
      setText(applied);
    }
  }, [applied, editing]);
  useEffect(() => cancel, []);
  return {
    value: text,
    onChange: (raw: string) => {
      setText(raw);
      setEditing(true);
      cancel();
      if (latest.current.ready(raw)) {
        timer.current = setTimeout(
          () => latest.current.commit(raw),
          TYPING_COMMIT_MS
        );
      }
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") {
        return;
      }
      e.preventDefault();
      cancel();
      if (latest.current.commit(text)) {
        setEditing(false);
      }
    },
    onBlur: () => {
      cancel();
      if (editing && text !== applied) {
        latest.current.commit(text);
      }
      setEditing(false);
      setText(applied);
      clearError();
    },
  };
}

// --- controls --------------------------------------------------------------------------------------

const isNumberText = (raw: string) =>
  raw.trim() !== "" && Number.isFinite(Number(raw));

function SpacingControl({
  label,
  path,
}: {
  label: string;
  path: keyof typeof SPACING_RANGE;
}) {
  const { id, eff, value, set, reset, clearError } =
    useResponsive<number>(path);
  const current = typeof value === "number" ? value : 0;
  const [min, max] = SPACING_RANGE[path];
  // An incomplete number ("", "-") is never tried; anything else goes through validation.
  const input = useCommittedText(
    String(current),
    (raw) => isNumberText(raw) && set(Number(raw)),
    isNumberText,
    clearError
  );
  return (
    <Row id={id} label={label} source={eff.source} onReset={reset}>
      <div className="flex items-center gap-1">
        <StepButton
          label={`Decrease ${label}`}
          onClick={() => set(Math.max(min, stepDown(current)))}
          disabled={current <= min}
        >
          <Minus className="h-3.5 w-3.5" />
        </StepButton>
        <input
          type="number"
          inputMode="numeric"
          className={`${inputClass} text-center`}
          value={input.value}
          min={min}
          max={max}
          step={4}
          aria-label={label}
          data-testid={`style-${id}`}
          onChange={(e) => input.onChange(e.target.value)}
          onKeyDown={input.onKeyDown}
          onBlur={input.onBlur}
        />
        <StepButton
          label={`Increase ${label}`}
          onClick={() => set(Math.min(max, stepUp(current)))}
          disabled={current >= max}
        >
          <Plus className="h-3.5 w-3.5" />
        </StepButton>
      </div>
    </Row>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded border border-border p-1.5 text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function ResponsiveSelect<T extends string>({
  label,
  path,
  options,
}: {
  label: string;
  path: ResponsivePath;
  options: [T, string][];
}) {
  const { id, eff, value, set, reset } = useResponsive<T>(path);
  return (
    <Row id={id} label={label} source={eff.source} onReset={reset}>
      <select
        className={inputClass}
        value={value ?? ""}
        aria-label={label}
        data-testid={`style-${id}`}
        onChange={(e) => e.target.value && set(e.target.value as T)}
      >
        {value === undefined && <option value="">Component default</option>}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

const ALIGNS: ["left" | "center" | "right", string][] = [
  ["left", "Left"],
  ["center", "Centre"],
  ["right", "Right"],
];

function AlignControl({
  label,
  path,
}: {
  label: string;
  path: ResponsivePath;
}) {
  const { id, eff, value, set, reset } = useResponsive<string>(path);
  return (
    <Row id={id} label={label} source={eff.source} onReset={reset}>
      <Segmented id={id} value={value} options={ALIGNS} onPick={set} />
    </Row>
  );
}

function Segmented<T extends string>({
  id,
  value,
  options,
  onPick,
}: {
  id: string;
  value: unknown;
  options: [T, string][];
  onPick: (v: T) => void;
}) {
  return (
    <div
      className="flex rounded border border-border p-0.5"
      role="group"
      data-testid={`style-${id}`}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          data-value={v}
          onClick={() => onPick(v)}
          className={`flex-1 rounded px-2 py-1 text-xs ${value === v ? "bg-accent text-black" : "text-muted-foreground hover:text-foreground"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function FlatSegmented<T extends string>({
  label,
  path,
  options,
}: {
  label: string;
  path: FlatPath;
  options: [T, string][];
}) {
  const { block, defaults, commit } = useCtx();
  const id = path.replaceAll(".", "-");
  const eff = effectiveFlat<T>(block.style, defaults, path);
  return (
    <FlatRow id={id} label={label} path={path}>
      <Segmented
        id={id}
        value={eff.value ?? options[0]![0]}
        options={options}
        onPick={(v) => commit(id, setFlatPatch(path, v))}
      />
    </FlatRow>
  );
}

/** Hide on the current device, with the cascade spelled out. */
function VisibilityControl({
  path = "hide",
  label = "Hidden",
}: {
  path?: ResponsivePath;
  label?: string;
}) {
  const { block, defaults } = useCtx();
  const { id, eff, value, set, reset } = useResponsive<boolean>(path);
  const { device } = useCtx();
  const hidden = value === true;
  const states = DEVICES.map((d) => ({
    d,
    hidden:
      effectiveResponsive<boolean>(block.style, defaults, path, d).value ===
      true,
  }));
  const showHidden = useShowHiddenBlocks();
  const isBlock = path === "hide";
  return (
    <>
      <Row
        id={id}
        label={`${label} on ${DEVICE_LABEL[device]}`}
        source={eff.source}
        onReset={reset}
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={hidden}
            onCheckedChange={(v) => set(v)}
            data-testid={`style-${id}`}
            aria-label={`${label} on ${DEVICE_LABEL[device]}`}
          />
          <span className="text-xs text-muted-foreground">
            {eff.source.kind === "inherited"
              ? `${hidden ? "Hidden" : "Shown"} because ${DEVICE_LABEL[eff.source.from]} is${hidden ? "" : " not"} hidden. Switch to override.`
              : hidden
                ? "Hidden on this device. Smaller devices inherit this unless set."
                : "Shown."}
          </span>
        </div>
        <div
          className="flex gap-1 text-[11px]"
          data-testid={`visibility-summary-${id}`}
        >
          {states.map((s) => (
            <span
              key={s.d}
              data-device={s.d}
              data-hidden={s.hidden ? "" : undefined}
              className={`rounded px-1.5 py-0.5 ${s.hidden ? "bg-accent text-muted-foreground line-through" : "bg-muted text-foreground"} ${
                s.d === device ? "ring-1 ring-primary" : ""
              }`}
            >
              {DEVICE_LABEL[s.d]}
            </span>
          ))}
        </div>
      </Row>
      {isBlock && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showHidden}
            onCheckedChange={setShowHiddenBlocks}
            data-testid="show-hidden-blocks"
          />
          Show hidden blocks on the canvas (faded)
        </label>
      )}
    </>
  );
}

// --- colours ---------------------------------------------------------------------------------------

/**
 * Brand swatches and a hex field. The hex is applied only when complete and valid (`HEX_RE`: #rgb,
 * #rgba, #rrggbb, #rrggbbaa) on Enter or blur, never while typing; Enter on an incomplete value
 * shows why, blur goes back to the applied colour.
 */
function ColorPicker({
  id,
  value,
  onPick,
  onBlur,
}: {
  id: string;
  value: Color | undefined;
  onPick: (c: Color) => boolean;
  /** Leaving the hex field: the text goes back to the applied colour, so drop a refusal shown for it. */
  onBlur: () => void;
}) {
  const hex = value && "hex" in value ? value.hex : "";
  const swatches = useContext(SwatchesContext);
  const [text, setText] = useState(hex);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(hex);
    setInvalid(false);
  }, [hex]);
  const apply = (raw: string): boolean => {
    const v = raw.trim();
    if (v === hex) {
      return true;
    }
    if (!HEX_RE.test(v)) {
      setInvalid(v !== "");
      return v === "";
    }
    setInvalid(false);
    return onPick({ hex: v });
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid={`color-${id}`}>
      <div className="flex flex-wrap gap-1">
        {BRAND_TOKENS.map((token) => {
          const selected =
            value !== undefined && "token" in value && value.token === token;
          return (
            <button
              key={token}
              type="button"
              title={token}
              aria-label={token}
              aria-pressed={selected}
              data-token={token}
              onClick={() => onPick({ token })}
              style={{ background: `var(--color-brand-${token})` }}
              className={`h-6 w-6 rounded border ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
            />
          );
        })}
        {swatches.map((sw) => {
          const selected = hex.toLowerCase() === sw.hex.toLowerCase();
          return (
            <button
              key={sw._key}
              type="button"
              title={sw.name ? `${sw.name} (${sw.hex})` : sw.hex}
              aria-label={sw.name ?? sw.hex}
              aria-pressed={selected}
              data-swatch={sw.hex}
              onClick={() => onPick({ hex: sw.hex })}
              style={{ background: sw.hex }}
              className={`h-6 w-6 rounded-full border ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
            />
          );
        })}
      </div>
      <input
        type="text"
        placeholder="#hex"
        className={inputClass}
        value={text}
        aria-invalid={invalid || undefined}
        aria-label="Hex colour"
        data-testid={`color-${id}-hex`}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") {
            return;
          }
          e.preventDefault();
          apply(text);
        }}
        onBlur={() => {
          if (!apply(text) || text.trim() === "") {
            setText(hex);
          }
          setInvalid(false);
          onBlur();
        }}
      />
      {!!invalid && (
        <p className="text-xs text-destructive">
          Use #rgb, #rgba, #rrggbb or #rrggbbaa.
        </p>
      )}
    </div>
  );
}

function ColorRow({
  label,
  path,
  contrast,
}: {
  label: string;
  path: FlatPath;
  contrast?: (fg: Color | undefined, merged: BlockStyle) => ContrastRating;
}) {
  const { block, defaults, merged, commit, clearError } = useCtx();
  const id = path.replaceAll(".", "-");
  const eff = effectiveFlat<Color>(block.style, defaults, path);
  return (
    <FlatRow id={id} label={label} path={path}>
      <ColorPicker
        id={id}
        value={eff.value}
        onPick={(c) => commit(id, setColorPatch(path, c))}
        onBlur={() => clearError(id)}
      />
      {!!contrast && <ContrastBadge rating={contrast(eff.value, merged)} />}
    </FlatRow>
  );
}

function ContrastBadge({ rating }: { rating: ContrastRating }) {
  if (rating.kind === "unknown") {
    return (
      <span
        className="w-fit rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title={rating.reason}
        data-testid="contrast-badge"
        data-state="unknown"
      >
        Contrast unknown · {rating.reason}
      </span>
    );
  }
  const ratio = `${rating.ratio.toFixed(2)}:1`;
  return rating.pass ? (
    <span
      className="w-fit rounded bg-emerald-800/60 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300"
      data-testid="contrast-badge"
      data-state="pass"
    >
      AA pass · {ratio} (needs {rating.threshold}:1)
    </span>
  ) : (
    <span
      className="w-fit rounded bg-destructive/80 px-1.5 py-0.5 text-[11px] font-semibold text-white"
      data-testid="contrast-badge"
      data-state="fail"
    >
      Fails AA · {ratio} (needs {rating.threshold}:1)
    </span>
  );
}

const GRADIENTS: [GradientPreset, string][] = [
  ["none", "None"],
  ["dark", "Dark fade"],
  ["ink-rise", "Ink rise"],
  ["primary-glow", "Primary glow"],
  ["accent-glow", "Accent glow"],
  ["accent-edge", "Accent edge"],
  ["accent-primary", "Accent → primary"],
];

function BackgroundControls() {
  const { block, defaults, merged, commit } = useCtx();
  const gradient = effectiveFlat<GradientPreset>(
    block.style,
    defaults,
    "background.gradient"
  );
  const image = effectiveFlat<
    NonNullable<NonNullable<BlockStyle["background"]>["image"]>
  >(block.style, defaults, "background.image");
  const opacity = image.value?.opacity ?? 0.6;
  const solid = solidBackground(merged);
  return (
    <>
      <ColorRow label="Colour" path="background.color" />
      <FlatRow
        id="background-gradient"
        label="Gradient"
        path="background.gradient"
      >
        <select
          className={inputClass}
          value={gradient.value ?? "none"}
          aria-label="Gradient"
          data-testid="style-background-gradient"
          onChange={(e) =>
            commit(
              "background-gradient",
              setFlatPatch("background.gradient", e.target.value)
            )
          }
        >
          {GRADIENTS.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </FlatRow>
      <FlatRow id="background-image" label="Image" path="background.image">
        <ImageField
          label="Background image (decorative)"
          value={
            image.value ? { mediaId: image.value.mediaId, alt: "" } : undefined
          }
          onChange={(v) =>
            commit(
              "background-image",
              v
                ? setFlatPatch("background.image", { mediaId: v.mediaId })
                : resetFlatPatch(block.style, "background.image")
            )
          }
        />
      </FlatRow>
      {!!image.value && (
        <>
          <ColorRow label="Image overlay" path="background.image.overlay" />
          <FlatRow
            id="background-image-opacity"
            label={`Overlay strength ${Math.round(opacity * 100)}%`}
            path="background.image.opacity"
          >
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(opacity * 100)}
              aria-label="Overlay strength"
              data-testid="style-background-image-opacity"
              onChange={(e) =>
                commit(
                  "background-image-opacity",
                  setFlatPatch(
                    "background.image.opacity",
                    Number(e.target.value) / 100
                  )
                )
              }
              className="accent-primary"
            />
          </FlatRow>
        </>
      )}
      {"reason" in solid && solid.reason !== "No background colour set" && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="background-contrast-note"
        >
          Contrast can't be rated: {solid.reason.toLowerCase()}.
        </p>
      )}
    </>
  );
}

// --- elements --------------------------------------------------------------------------------------

const SIZES: [TextSize, string][] = [
  ["sm", "Small"],
  ["base", "Base"],
  ["lg", "Large"],
  ["xl", "XL"],
  ["2xl", "2XL"],
];

function ElementControls({
  name,
  props,
  onCard,
}: {
  name: string;
  props: readonly string[];
  onCard: boolean;
}) {
  const { block, defaults, device } = useCtx();
  const size = effectiveResponsive<TextSize>(
    block.style,
    defaults,
    `elements.${name}.size`,
    device
  ).value;
  return (
    <fieldset
      className="flex flex-col gap-3 rounded border border-border p-2"
      data-testid={`style-element-${name}`}
    >
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {humanize(name)}
      </legend>
      {props.includes("color") && (
        <ColorRow
          label="Colour"
          path={`elements.${name}.color`}
          // Large (3:1) only when its size is set to one known to be ≥24px; else 4.5:1.
          contrast={(fg, m) => rateContrast(fg, m, isLargeSize(size), onCard)}
        />
      )}
      {props.includes("size") && (
        <ResponsiveSelect
          label="Size"
          path={`elements.${name}.size`}
          options={SIZES}
        />
      )}
      {props.includes("align") && (
        <AlignControl label="Align" path={`elements.${name}.align`} />
      )}
      {props.includes("hide") && (
        <VisibilityControl path={`elements.${name}.hide`} label="Hidden" />
      )}
    </fieldset>
  );
}

const humanize = (name: string) =>
  name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
