---
status: accepted
date: 2026-11-22
decision-makers:
  - ochanuco
---

# 声の指示を、PartnerDO から yunomi-voice への WebSocket で届ける

## 要約

VC を relay から yunomi-voice に移すと声の指示の届け先が無くなる課題に対して、yunomi-voice がキャラごとの PartnerDO に WebSocket をつなぎ、Worker が声の指示をそこへ押し出す形を選び、relay が LAN 越しに渡す案、VC のテキストチャットも yunomi-voice が受ける案、yunomi-voice を Tunnel で公開して Worker から呼ぶ案を退けた。音声の経路が Discord でなくなっても yunomi-voice が core と直接つながるためで、PartnerDO に WebSocket の受け口を持ち、つなぎ直しを yunomi-voice が受け持つことは受け入れる。

## 背景と課題

Worker から常駐部分へ話しかける経路は無く、常駐部分が Worker を呼んだときの応答で指示を返している。relay が VC を持っていたあいだは、Worker を呼ぶのも応答の声の指示を VC で流すのも relay だったので、それで足りていた。

VC を yunomi-voice に移すと、持ち主の発話と VC の状態は yunomi-voice が Worker を呼ぶので、今までどおり応答で返せる。一方、VC のテキストチャットに文字で書かれた発言は relay が受けて Worker を呼ぶ。その返事の声の指示は relay への応答に載り、VC を持たない relay では流せない。

決める範囲は、Worker から yunomi-voice へ声の指示を届ける経路。

## 判断の決め手

- Discord は音声の経路の 1 つで、ほかの経路に替えても yunomi-voice は core とつながっていたい
- 判断は core に置き、yunomi-voice は反射だけを持つ
- 一日中つないでいても費用が増えない
- yunomi-box に外から受ける口を増やさない

## 検討した選択肢

1. yunomi-voice がキャラごとの PartnerDO に WebSocket をつなぎ、Worker が押し出す
2. relay が受け取った声の指示を、LAN 越しに yunomi-voice へ渡す
3. VC のテキストチャットの発言も yunomi-voice が受け、自分で Worker を呼ぶ
4. yunomi-voice を Cloudflare Tunnel と Access で公開し、Worker から呼ぶ

## 決定

選択肢 1 を選ぶ。

- yunomi-voice は起動時に、扱うキャラの PartnerDO それぞれに WebSocket をつなぐ。Access の service token は voice 用を使う
- PartnerDO は Hibernation API（`acceptWebSocket`）で受け、生存確認には `setWebSocketAutoResponse` で答える。つないだまま待っているあいだ、PartnerDO は起きない
- VC のテキストチャットの発言で声の指示ができたとき、yunomi-voice がつながっていれば WebSocket に送り、relay への応答には載せない
- 持ち主の発話と VC の状態は、今の HTTP の口のまま送り、応答で返す

### 結果

- 良い点: 音声の経路を Discord から替えても、yunomi-voice と core のつながりはそのまま使える
- 良い点: yunomi-voice からの外向きの接続だけで済み、yunomi-box に受ける口が増えない
- 良い点: 押し出しの線があるので、後で返事を文ごとに流すときや、割り込みでどこまで話したかを返すときにも使える
- 悪い点: PartnerDO に WebSocket の受け口と、つながっているかどうかで送り先を変える分岐が増える
- 悪い点: 切断やつなぎ直しのあいだに届いた声の指示を、yunomi-voice か PartnerDO が扱う必要がある
- 悪い点: Hibernation API を使わずに受けると、つないでいるあいだずっと PartnerDO の時間の費用がかかる。受け方を変えるときは、この点を崩さないようにする

## 選択肢ごとの良い点と悪い点

- relay が LAN 越しに渡す: Worker を変えずに済む。relay に声の役割が残り、Discord をやめると経路ごと無くなる
- VC のテキストチャットも yunomi-voice が受ける: 押し出しが要らない。発言を Envelope に変える処理を relay と二重に持ち、yunomi-box が止まると VC のテキストチャットにも返事がつかない。Discord をやめると成り立たない
- Tunnel で公開して Worker から呼ぶ: ochoko と同じ形にできる。yunomi-box に外から受ける口が増え、Access の設定も増える
