#!/usr/bin/env bun
// Imports the starter content (home, about, pricing, contact, three posts, site menu and footer)
// into the LOCAL dev state (.wrangler/state/v3: D1 `DB`, KV `CMS_PAGES`, R2 `CMS_MEDIA`) through
// the same service the /admin/setup button calls. Idempotent: run it twice and nothing is
// duplicated. Never touches remote resources.
//
//   bun run seed        (from apps/web, after `bun run dev` has applied the migrations once)
import { importStarterContent } from "@repo/services/cms/starter-import";
import { getPlatformProxy } from "wrangler";

import { cmsServices } from "../src/server/cms/wiring";

const proxy = await getPlatformProxy<Env>({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/state/v3" },
  remoteBindings: false,
});

try {
  // SITE_ORIGIN is empty in wrangler.jsonc and only the dev server falls back to the request
  // origin. The site settings' organization needs an https URL, so a placeholder stands in; edit
  // it in /admin/site (or set SITE_ORIGIN) for a real site.
  const origin = proxy.env.SITE_ORIGIN.trim() || "https://example.com";
  const { pagesDeps, siteDeps, mediaDeps } = cmsServices({
    ...proxy.env,
    SITE_ORIGIN: origin,
  } as Env);
  const { items, site } = await importStarterContent({
    media: mediaDeps,
    pages: pagesDeps,
    site: siteDeps,
  });
  for (const item of items) {
    console.log(`${item.action.padEnd(7)} ${item.path}`);
  }
  console.log(`site settings: ${site}`);
} finally {
  await proxy.dispose();
}
