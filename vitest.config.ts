import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations"), BOT_TOKEN: "fake-token", CLIENT_ID: "123", DISCORD_PUBLIC_KEY: "00".repeat(32) } }
  })],
  test: { include: ["tests/cloudflare/**/*.test.ts", "tests/unit/accounting.test.ts", "tests/unit/exchange.test.ts"], setupFiles: ["./tests/cloudflare/setup.ts"] }
}));
