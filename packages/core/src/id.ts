import { uuidv7 } from "uuidv7";

/** 時系列に並ぶ ID。主キーなど順序が有用な用途向け。 */
export const newId = (): string => uuidv7();

/** 生成時刻を推測させたくない ID（外部に出す識別子など）向けの v4。 */
export const newOpaqueId = (): string => crypto.randomUUID();
