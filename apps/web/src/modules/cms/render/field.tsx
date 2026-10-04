import { type CmsVars, computeElementVars } from "@repo/cms-core/style/vars";
import type { ElementStyle } from "@repo/cms-core/types";
import { createContext, useCallback, useContext } from "react";

import { useEditMode } from "./edit-mode";

/** Merged (default + user) element styles of the enclosing block, provided by BlockWrapper. */
export const ElementStylesContext = createContext<
  Record<string, ElementStyle> | undefined
>(undefined);

export type FieldProps = { style?: CmsVars } & Record<
  `data-cms-${string}`,
  string
>;

/** Props for a styleable element: style vars + hide/marker attrs, and `data-cms-field` in edit mode only. */
export function field(
  name: string,
  style: ElementStyle | undefined,
  editing: boolean
): FieldProps {
  const { style: vars, attrs } = computeElementVars(style);
  const props: FieldProps = { ...attrs };
  if (Object.keys(vars).length) {
    props.style = vars;
  }
  if (editing) {
    props["data-cms-field"] = name;
  }
  return props;
}

/** `const f = useField(); <h2 {...f("heading")} className="…">` */
export function useField(): (name: string) => FieldProps {
  const { editing } = useEditMode();
  const elements = useContext(ElementStylesContext);
  return useCallback(
    (name: string) => field(name, elements?.[name], editing),
    [elements, editing]
  );
}
