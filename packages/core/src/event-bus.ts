import type { Envelope } from "./envelope.ts";

export interface EventBus {
	publish(envelope: Envelope): Promise<void>;
}

/** テスト用。publish された順に保持する。 */
export class InMemoryEventBus implements EventBus {
	readonly published: Envelope[] = [];

	async publish(envelope: Envelope): Promise<void> {
		this.published.push(envelope);
	}
}
