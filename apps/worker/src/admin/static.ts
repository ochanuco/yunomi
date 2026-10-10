import { ADMIN_ASSETS } from "../generated/admin-assets.ts";

export const ADMIN_BASE = "/admin/";

type Assets = typeof ADMIN_ASSETS;

/**
 * apps/admin のビルド成果物を /admin/ 配下で返す。HTML に機密は無く、
 * 認可が要るデータは /admin/api/ 側で検証する（ホスト全体は Access が保護）。
 */
export const serveAdminAsset = (
	request: Request,
	assets: Assets = ADMIN_ASSETS,
): Response => {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return Response.json({ error: "method_not_allowed" }, { status: 405 });
	}
	const { pathname } = new URL(request.url);
	if (pathname === "/admin") {
		return new Response(null, {
			status: 308,
			headers: { location: ADMIN_BASE },
		});
	}
	if (!pathname.startsWith(ADMIN_BASE)) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}
	const key =
		pathname === ADMIN_BASE
			? "/index.html"
			: pathname.slice(ADMIN_BASE.length - 1);
	const asset = Object.hasOwn(assets, key) ? assets[key] : undefined;
	if (!asset) return Response.json({ error: "not_found" }, { status: 404 });

	const immutable = key.startsWith("/assets/");
	return new Response(request.method === "HEAD" ? null : asset.body, {
		headers: {
			"content-type": asset.type,
			// ファイル名にハッシュが入る /assets/ だけ長期キャッシュする。
			"cache-control": immutable
				? "public, max-age=31536000, immutable"
				: "no-cache",
		},
	});
};
