#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./commands.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

const code = await run(process.argv.slice(2), {
	fetch: (input, init) => fetch(input, init),
	env: process.env,
	out: (text) => console.log(text),
	err: (text) => console.error(text),
	now: () => new Date(),
	sleep: (ms, signal) =>
		sleep(ms, undefined, { signal }).catch(() => undefined),
	signal: controller.signal,
	writeFile: (path, bytes) => writeFile(path, bytes),
});
process.exitCode = code;
