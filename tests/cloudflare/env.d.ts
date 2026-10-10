import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
			GATEWAY: DurableObjectNamespace;
			BOT_TOKEN: string;
			CLIENT_ID: string;
			DISCORD_PUBLIC_KEY: string;
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
