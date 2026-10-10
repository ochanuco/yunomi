import { writeFileSync } from "node:fs";
import { generatedPath, renderGenerated } from "./build.ts";

writeFileSync(generatedPath, renderGenerated());
