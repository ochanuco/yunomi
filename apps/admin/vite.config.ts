import { defineConfig } from "vitest/config";

// 本番では Worker が /admin/ 配下でこのビルド成果物を返す（apps/worker の admin-assets）。
const API_TARGET = process.env.ADMIN_API_TARGET ?? "http://localhost:8787";

export default defineConfig({
	base: "/admin/",
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: {
			// ローカルでは Access の代わりに dev caller ヘッダで ykm 相当として通す。
			"/admin/api": {
				target: API_TARGET,
				headers: { "x-yunomi-dev-caller": "ykm" },
			},
		},
	},
	test: { environment: "happy-dom" },
});
