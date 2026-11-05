import { timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import {
	type DiscordMessageCreatedEnvelope,
	discordMessageCreatedEnvelopeSchema,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Logger } from "./logger.ts";

export const EVENTS_PATH = "/events";
const BODY_LIMIT = 1_000_000;

export type ServerDeps = {
	sharedToken: string;
	accept: (envelope: DiscordMessageCreatedEnvelope) => void;
	logger: Logger;
};

export const authorized = (
	header: string | undefined,
	token: string,
): boolean => {
	if (!header?.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

export const readBody = (req: IncomingMessage): Promise<string | null> =>
	new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > BODY_LIMIT) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(null));
	});

export const reply = (res: ServerResponse, status: number) => {
	res.writeHead(status).end();
};

/**
 * gateway から envelope を受ける。仕事は数分かかるので、受け取った時点で 202 を返し、処理は待たない。
 */
export const createWorkingServer = (deps: ServerDeps): Server =>
	createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/healthz") return reply(res, 200);
		if (req.url !== EVENTS_PATH) return reply(res, 404);
		if (req.method !== "POST") return reply(res, 405);
		if (!authorized(req.headers.authorization, deps.sharedToken)) {
			return reply(res, 401);
		}
		const raw = await readBody(req);
		if (raw === null) return reply(res, 413);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return reply(res, 400);
		}
		const parsed = v.safeParse(discordMessageCreatedEnvelopeSchema, json);
		if (!parsed.success) {
			deps.logger.warn("invalid envelope", {
				issues: parsed.issues.map((i) => i.message),
			});
			return reply(res, 400);
		}
		deps.accept(parsed.output as DiscordMessageCreatedEnvelope);
		return reply(res, 202);
	});
