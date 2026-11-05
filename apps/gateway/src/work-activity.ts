import type { Logger } from "./logger.ts";
import type { WorkingClient } from "./working-client.ts";

export const WORK_ACTIVITY_INTERVAL_MS = 60_000;

/** bot のステータスに出す文。作業中の席がなければ出さない。 */
export const workActivityText = (working: number): string | null =>
	working > 0 ? `作業中 ${working}件` : null;

type WorkActivityOptions = {
	working: Pick<WorkingClient, "seatSummary">;
	/** null で消す。 */
	setActivity: (text: string | null) => void;
	logger: Logger;
	intervalMs?: number;
};

/** 受付から作業中の席の数を読み、bot のステータスに出し続ける。止める関数を返す。 */
export const startWorkActivity = (opts: WorkActivityOptions): (() => void) => {
	let shown: string | null = null;
	const update = async () => {
		const r = await opts.working.seatSummary();
		if (!r.ok) {
			opts.logger.debug("seat summary unavailable", { error: r.error.type });
		}
		// 読めないときは古い数を出したままにしない
		const text = r.ok ? workActivityText(r.value.working) : null;
		if (text === shown) return;
		shown = text;
		opts.setActivity(text);
	};
	void update();
	const timer = setInterval(
		() => void update(),
		opts.intervalMs ?? WORK_ACTIVITY_INTERVAL_MS,
	);
	timer.unref();
	return () => clearInterval(timer);
};
