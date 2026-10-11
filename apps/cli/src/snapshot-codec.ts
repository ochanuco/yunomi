import { type Snapshot, SnapshotSchema } from "@yunomi/admin-contract";
import { Decrypter } from "age-encryption";
import * as v from "valibot";

export type DecryptResult =
	| { ok: true; value: Snapshot }
	| { ok: false; message: string };

/** age → gzip → JSON → 検証。平文はメモリの上だけで扱い、ファイルには書かない。 */
export const decryptSnapshot = async (
	encrypted: Uint8Array,
	identity: string,
): Promise<DecryptResult> => {
	let json: string;
	try {
		const decrypter = new Decrypter();
		decrypter.addIdentity(identity);
		const gzipped = await decrypter.decrypt(encrypted);
		json = await new Response(
			new Blob([gzipped]).stream().pipeThrough(new DecompressionStream("gzip")),
		).text();
	} catch (e) {
		return {
			ok: false,
			message: `復号できない: ${e instanceof Error ? e.message : e}`,
		};
	}
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return { ok: false, message: "復号した内容が JSON ではない" };
	}
	const parsed = v.safeParse(SnapshotSchema, data);
	return parsed.success
		? { ok: true, value: parsed.output }
		: {
				ok: false,
				message: `Snapshot が admin-contract と一致しない: ${parsed.issues[0]?.message ?? ""}`,
			};
};
