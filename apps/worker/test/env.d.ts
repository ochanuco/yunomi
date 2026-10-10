import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			ALLOW_DEV_CALLER_BY_MODE: Record<string, string>;
		}
	}
}
