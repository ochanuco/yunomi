// skip された待機の coalesced も順番待ちの一部として、前の分が終わってから順に走らせる。
type Turn = { run: boolean; after: Promise<void>; done: () => void };
type Slot = { waiters: ((turn: Turn) => void)[] };

/**
 * チャンネル単位の直列化。処理中に届いた呼び出しは待たせ、終了時に最新の 1 件だけを実行し、
 * それより古い待機は skip（coalesce）として解放する。
 */
export class ChannelGate {
	readonly #slots = new Map<string, Slot>();

	async run<T>(
		channelId: string,
		work: () => Promise<T>,
		coalesced: () => T | Promise<T>,
	): Promise<T> {
		let slot = this.#slots.get(channelId);
		if (slot) {
			const mine = slot;
			const turn = await new Promise<Turn>((resolve) => {
				mine.waiters.push(resolve);
			});
			await turn.after;
			if (!turn.run) {
				try {
					return await coalesced();
				} finally {
					turn.done();
				}
			}
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
		let after = Promise.resolve();
		for (const w of waiters) {
			const prev = after;
			after = new Promise<void>((done) => w({ run: false, after: prev, done }));
		}
		newest({ run: true, after, done: () => {} });
	}
}
