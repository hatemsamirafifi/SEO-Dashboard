import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig, loadEnv } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { devtools } from "@tanstack/devtools-vite";
import { leanWorkerBundle } from "./vite-plugin-lean-worker-bundle";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : env.PORT
      ? Number(env.PORT)
      : 3001;
  const showDevtools = env.VITE_SHOW_DEVTOOLS !== "false";
  const allowedHosts = [
    env.ALLOWED_HOST,
    env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).hostname : undefined,
  ].filter((host): host is string => Boolean(host));
  const emitSourcemaps = env.POSTHOG_SOURCEMAPS === "true";

  return {
    envPrefix: [
      "VITE_",
      "AUTH_MODE",
      "BYPASS_EMAIL_VERIFICATION",
      "POSTHOG_PUBLIC_KEY",
      "POSTHOG_HOST",
      "TURNSTILE_SITE_KEY",
    ],
    server: {
      allowedHosts,
      host: true,
      port,
      hmr: {
        overlay: false,
      },
      watch: {
        ignored: [
          "**/.git/**",
          "**/.wrangler/**",
          "**/.agents/**",
          "**/dist/**",
          "**/coverage/**",
          "**/.logs/**",
          "**/docs/**",
          "**/release-notes/**",
          "**/specs/**",
          "**/badseo/**",
          "**/web/**",
          "**/.pnpm-store/**",
          "**/.claude/**",
          "**/.codex/**",
          "**/.opencode/**",
          "**/.specify/**",
          "**/.vscode/**",
          "**/e2e/**",
          "**/planning/**",
          "**/drizzle/**",
          "**/drizzle-pg/**",
          "**/scripts/**",
          "**/*.md",
          "**/*.mdx",
          "**/*.log",
          "**/*.test.*",
          "**/*.spec.*",
        ],
      },
    },
    preview: {
      allowedHosts,
      host: true,
      port,
    },
    build: {
      sourcemap: emitSourcemaps,
      outDir: emitSourcemaps ? "dist-sourcemaps" : "dist",
    },
    esbuild: {
      // Emit every chunk as pure ASCII: esbuild rewrites each non-ASCII
      // character in string, regex, and identifier tokens as a \uXXXX escape.
      // V8 stores files containing characters outside Latin-1 at 2 bytes per char,
      // which doubles the worker chunk memory from 7.8MB to 15.5MB in the 128MB isolate heap.
      charset: "ascii",
    },
    plugins: [
      leanWorkerBundle(),
      showDevtools
        ? devtools({
            consolePiping: {
              enabled: false,
            },
          })
        : null,
      cloudflare({
        configPath: "./wrangler.jsonc",
        viteEnvironment: { name: "ssr" },
      }),
      tanstackStart(),
      tailwindcss(),
      viteReact(),
      tsConfigPaths(),
    ],
  };
});
