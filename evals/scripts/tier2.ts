import { defaultDeps, main } from "../src/cli.ts";

// pnpm は `pnpm run x -- --flag` の `--` をそのまま渡すので取り除く。
const args = process.argv.slice(2).filter((a) => a !== "--");
process.exitCode = await main(args, defaultDeps(process.env));
