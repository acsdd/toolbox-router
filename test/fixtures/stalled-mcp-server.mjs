import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.env.TOOLBOX_MCP_HOME, "stalled.pid"), String(process.pid));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1_000);
