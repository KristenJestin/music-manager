import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  plugins: [
    // Bun is the runtime in dev and in production, so build for the Bun Nitro preset.
    nitro({ preset: "bun" }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
