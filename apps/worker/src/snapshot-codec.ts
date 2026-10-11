import { type Snapshot, SnapshotSchema } from "@yunomi/admin-contract";
import { Encrypter } from "age-encryption";
import * as v from "valibot";

const collect = async (stream: ReadableStream<Uint8Array>) =>
	new Uint8Array(await new Response(stream).arrayBuffer());

/** JSON → gzip → age。Worker は recipient（公開鍵）だけを持ち、復号はできない。 */
export const encryptSnapshot = async (
	snapshot: Snapshot,
	recipient: string,
): Promise<Uint8Array> => {
	const json = new TextEncoder().encode(JSON.stringify(snapshot));
	const gzipped = await collect(
		new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
	);
	const encrypter = new Encrypter();
	encrypter.addRecipient(recipient);
	return encrypter.encrypt(gzipped);
};

/** restore の body など、境界で受け取った Snapshot の検証。 */
export const parseSnapshot = (
	input: unknown,
): { ok: true; value: Snapshot } | { ok: false; message: string } => {
	const parsed = v.safeParse(SnapshotSchema, input);
	return parsed.success
		? { ok: true, value: parsed.output }
		: {
				ok: false,
				message: parsed.issues
					.slice(0, 3)
					.map((i) => `${v.getDotPath(i) ?? ""}: ${i.message}`)
					.join(", "),
			};
};
