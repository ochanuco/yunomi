type Slot = { waiters: ((decision: "run" | "skip") => void)[] };

/**
 * チャンネル単位の直列化。処理中に届いた呼び出しは待たせ、終了時に最新の 1 件だけを実行し、
 * それより古い待機は skip（coalesce）として解放する。
 */
export class ChannelGate {
	readonly #slots = new Map<string, Slot>();

	async run<T>(
		channelId: string,
		work: () => Promise<T>,
		coalesced: () => T,
	): Promise<T> {
		let slot = this.#slots.get(channelId);
		if (slot) {
			const mine = slot;
			const decision = await new Promise<"run" | "skip">((resolve) => {
				mine.waiters.push(resolve);
			});
			if (decision === "skip") return coalesced();
		} else {
			slot = { waiters: [] };
			this.#slots.set(channelId, slot);
		}
		try {
			return await work();
		} finally {
			this.#next(channelId, slot);
		}
	}

	#next(channelId: string, slot: Slot): void {
		const waiters = slot.waiters;
		slot.waiters = [];
		const newest = waiters.pop();
		if (!newest) {
			this.#slots.delete(channelId);
			return;
		}
		for (const w of waiters) w("skip");
		newest("run");
	}
}
