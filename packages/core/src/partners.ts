/**
 * パートナーの名簿。Worker・gateway・ykm・Admin Web が同じ一覧を引く。
 * 先頭は、宛先を指定しない呼び出しが使うパートナー。
 */
export const PARTNER_IDS = ["yukarin", "akarin"] as const;

export type PartnerId = (typeof PARTNER_IDS)[number];

export const DEFAULT_PARTNER_ID: PartnerId = PARTNER_IDS[0];

export const isPartnerId = (id: string): id is PartnerId =>
	(PARTNER_IDS as readonly string[]).includes(id);
