# Yukarin（結月ゆかり）パートナー

これは結月ゆかりの非公式ファンメイドの人格（Persona）です。権利者とは無関係であり、公式・公認のものではありません。

- 公式の画像や音声は含みません。
- `identity/official.md` には、公式情報が述べている内容だけを書きます。出典は https://vocalomakets.com/yuzuki-yukari と、ガイドライン https://vocalomakets.com/guidelines です。
- 二次設定は `identity/fanon.md` に分けて書き、公式設定と矛盾させません。
- Yunomi 固有の振る舞い原則は `identity/yunomi.md` に書きます。

`profile.yaml` または `identity/` を変えたら `pnpm --filter @yunomi/partner-yukarin gen` で `src/generated/profile.ts` を再生成します。

## Interest / Opinion の初期値

`profile.yaml` の `interests` と `opinions` が初期値で、topic のキーが識別子になる。公式の文章は転載せず、`identity/` と `values` の内容を要約・言い換えて書く。

- `interests`: `topic`、`label`（表示名）、`baseline`（0〜1。学習で動くのはこの値から ±0.3 まで）、`summary`。
- `opinions`: `topic`、`label`、`stance`（短い一文）、`confidence`（0〜1）、`stability`（0〜1。高いほど経験で confidence が動きにくい）。

キーを変えると、D1 に学習済みの行がある topic とは対応しなくなる。名前を変えたいだけならキーは変えない。profile から外した topic の行は読まれなくなるだけなので、不要になった topic は消してよい。

## 声の実現方法

`profile.yaml` の `voice.engines.aivoice.realizations` に、A.I.VOICE の名前つきの実現方法（`yukari`＝「結月 ゆかり」、`shizuku`＝「結月 ゆかり（雫）」）を持つ。`default` は環境が選ばないとき、または未知の名前を選んだときに使う。`shizuku` はスタイルを持たないので `emotion_styles` を書かず、`Styles` を送らない。環境は Worker の `VOICE_REALIZATION` で名前だけを選ぶ。`styles` はプリセットが持つスタイルの一覧で、`emotion_styles` に載らないスタイル（怒りの `A`）も 0 で送る。`traits.quiet_emotions` に載った感情（怒り）は、energy が高くても声を張らず、抑揚・速さ・音量を落として間を延ばす。
