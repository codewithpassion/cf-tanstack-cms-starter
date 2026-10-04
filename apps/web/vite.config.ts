import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Remote bindings (only Workers AI, `AI`) need a Cloudflare login.
// CF_REMOTE_BINDINGS=0 turns them off so dev starts without credentials.
const remoteBindings = process.env.CF_REMOTE_BINDINGS !== "0";

const config = defineConfig(({ command }) => ({
  // True only in a dev server started with CF_REMOTE_BINDINGS=0: Workers AI can't run there.
  // Builds always get false.
  define: {
    __WORKERS_AI_OFF__: JSON.stringify(command === "serve" && !remoteBindings),
  },
  plugins: [
    devtools(),
    cloudflare({ remoteBindings, viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
}));

export default config;
