import type { BrandSwatch } from "@repo/cms-core/site/types";
import { createContext } from "react";

/**
 * The site doc's saved custom colours (`/admin/site`), offered by the style panel's colour picker
 * after the brand tokens. Provided by the editor route; its own module so the route chunk doesn't
 * pull in the style panel.
 */
export const SwatchesContext = createContext<BrandSwatch[]>([]);
