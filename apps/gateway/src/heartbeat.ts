import { writeFileSync } from "node:fs";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_HEARTBEAT_PATH = "/tmp/yunomi-gateway.heartbeat";

type HeartbeatOptions = {
	path: string;
	isReady: () => boolean;
	intervalMs?: number;
	now?: () => Date;
	write?: (path: string, data: string) => void;
};

// Gateway は HTTP を持たないため、Docker の HEALTHCHECK 用にファイルの更新時刻で生存を示す。
// 接続が切れている間は書かない（古くなって unhealthy になる）。
export const startHeartbeat = (options: HeartbeatOptions): (() => void) => {
	const {
		path,
		isReady,
		intervalMs = HEARTBEAT_INTERVAL_MS,
		now = () => new Date(),
		write = writeFileSync,
	} = options;
	const beat = () => {
		if (!isReady()) return;
		try {
			write(path, now().toISOString());
		} catch {
			// 書けない場合は古いままにして unhealthy にする
		}
	};
	beat();
	const timer = setInterval(beat, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
};
