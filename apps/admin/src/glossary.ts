import {
	DAILY_RELATIONSHIP_CAP,
	DEGRADED_FAILURE_THRESHOLD,
	ENERGY_DECAY_HALF_LIFE_HOURS,
	MOOD_DECAY_HALF_LIFE_HOURS,
	STRESS_ON_DEGRADED,
	STRESS_PER_FAILURE,
	STRESS_RECOVERY,
	TURN_CAPS,
} from "@yunomi/core";
import { pct } from "./format.ts";

// 数値は core の定数から組み立てる。調整したときに説明だけ古くならないようにするため。
const GLOSSARY: Record<string, string> = {
	mood: `機嫌（-100% 〜 100%）。返事の調子と、自分から話に入るかの判断に使う。1 ターンで動くのは ±${pct(TURN_CAPS.mood.up)} まで。時間がたつと初期値へ戻り、差が半分になるのに ${MOOD_DECAY_HALF_LIFE_HOURS} 時間かかる。`,
	energy: `元気（0% 〜 100%）。低いと返事も割り込みも控えめになる。1 ターンで動くのは ±${pct(TURN_CAPS.energy.up)} まで。時間がたつと初期値へ戻り、差が半分になるのに ${ENERGY_DECAY_HALF_LIFE_HOURS} 時間かかる。`,
	presence:
		"在席状況。available 以外のときは自分から話に入るのを控える。sleeping / busy / do_not_disturb のときはボイスチャンネルにもついていかない。",
	system_stress: `LLM の失敗が続いた度合い（0% 〜 100%）。degraded に入ると +${pct(STRESS_ON_DEGRADED)}、その間の失敗 1 回で +${pct(STRESS_PER_FAILURE)}、成功 1 回で -${pct(STRESS_RECOVERY)}。返事の内容には使っていない。`,
	degraded_mode: `成功を挟まずに LLM が ${DEGRADED_FAILURE_THRESHOLD} 回続けて失敗した状態。グラフでは帯で示す。`,
	version: "State を更新するたびに 1 増える。",
	familiarity: `親しさ（0% 〜 100%）。話すときの距離感の段階を決める。trust との平均で関係の段階も決まり、自分から話に入るかや、ボイスチャンネルについていくかに効く。1 ターンで +${pct(TURN_CAPS.familiarity.up)} / -${pct(TURN_CAPS.familiarity.down)} まで、増えるのは 1 日 ${pct(DAILY_RELATIONSHIP_CAP)} まで。時間では戻らない。`,
	trust: `信頼（0% 〜 100%）。値のまま返事のプロンプトに渡す。familiarity との平均で関係の段階も決まる。1 ターンで +${pct(TURN_CAPS.trust.up)} / -${pct(TURN_CAPS.trust.down)} まで、増えるのは 1 日 ${pct(DAILY_RELATIONSHIP_CAP)} まで。時間では戻らない。`,
};

const ALIASES: Record<string, string> = {
	"system stress": "system_stress",
	degraded: "degraded_mode",
	親しさ: "familiarity",
	信頼: "trust",
};

/** 画面に出す項目名から説明を引く。説明のない項目は undefined。 */
export const explain = (label: string): string | undefined =>
	GLOSSARY[ALIASES[label] ?? label];
