# apps/working

Working（仕事）を受け持つコンテナの土台。`orca serve` と Claude CLI を 1 つの Linux コンテナで動かし、Yukarin の人格で Claude CLI に答えさせる。

## 中身

| ファイル | 役割 |
| --- | --- |
| `Dockerfile` | Debian に Orca の Linux 版（`orca-ide`）と Claude CLI を入れる。人格の元ファイルも入れる |
| `persona.sh` | `partners/yukarin` の `identity/*.md`・`profile.yaml`・`examples.yaml` を連結し、system prompt として標準出力に出す |

Orca の Linux 版は GitHub Releases（`stablyai/orca`）の `orca-ide_<版>_<arch>.deb` を使う。CLI の名前は `orca` ではなく `orca-ide`。版は `ORCA_VERSION` で Mac の Orca と揃える。

## volume

| volume | マウント先 | 残るもの |
| --- | --- | --- |
| `yunomi-working-claude` | `/home/worker/.claude` | Claude CLI のログイン情報（`.credentials.json`）、設定（`.claude.json`）、セッション（`projects/`） |
| `yunomi-working-orca` | `/home/worker/.config` | orcad の本体と状態、pairing 済みの端末 |

`CLAUDE_CONFIG_DIR` を `~/.claude` に向けているので、通常は `~/.claude.json` に置かれる設定も volume に入る。

## 試し方

リポジトリの root で行う。

```sh
docker build -f apps/working/Dockerfile -t yunomi-working:spike .

docker run -d --name working \
  -p 127.0.0.1:16768:6768 \
  -v yunomi-working-claude:/home/worker/.claude \
  -v yunomi-working-orca:/home/worker/.config \
  yunomi-working:spike \
  orca-ide serve --port 6768 --pairing-address 127.0.0.1:16768
```

Mac の Orca が 127.0.0.1:6768 を使っているため、ホスト側のポートは 6768 以外にする。6768 のままだと Mac の Orca 自身に繋がり、`4001: Unauthorized` で断られる。`--pairing-address` は Mac から届くアドレスにする。

### 1. Mac の Orca から接続する

```sh
code=$(docker logs working 2>&1 | grep '^Pairing URL:' | tail -1 | sed 's/^Pairing URL: //')
orca environment add --name working --pairing-code "$code"
orca status --environment working   # runtimeConnectionState: connected
```

pairing のコードは端末の認証情報なので、ログや Issue に貼らない。

### 2. Claude CLI にログインする

```sh
docker exec -it working claude   # /login で表示された URL を開いて承認し、/exit
docker exec working claude auth status
```

### 3. Yukarin の人格で答えさせる

```sh
docker exec working bash -c '
~/bin/persona.sh > /tmp/persona.md
claude -p --system-prompt-file /tmp/persona.md --output-format json "はじめまして。好きな飲み物は焙じ茶です" \
  | jq -r ".session_id, .result"'
```

### 4. 続きから答えさせる

3 で出た `session_id` を渡す。

```sh
docker exec working bash -c '
~/bin/persona.sh > /tmp/persona.md
claude -p --resume <session_id> --system-prompt-file /tmp/persona.md "私の好きな飲み物は何でしたっけ？"'
```

`docker rm -f working` で作り直してから同じことをしても、ログイン・セッション・pairing は volume に残る。
