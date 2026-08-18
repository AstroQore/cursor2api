/**
 * Diagnostic: call agent.v1.AgentService/GetUsableModels and print the raw result.
 * Run: npx tsx scripts/debug-models.ts
 */
import protobuf from "protobufjs";
import { loadConfig } from "../src/config.js";
import { AccountPool } from "../src/auth.js";
import { unaryCall } from "../src/cursor/unary.js";

const config = loadConfig();
const pool = new AccountPool(config.authFile, (m) => console.log(`[pool] ${m}`));
const account = await pool.next();

const root = protobuf.loadSync("proto/agent.proto");
const Req = root.lookupType("agent.v1.GetUsableModelsRequest");
const Res = root.lookupType("agent.v1.GetUsableModelsResponse");

for (const path of [
  "/agent.v1.AgentService/GetUsableModels",
  "/agent.v1.AgentService/GetDefaultModelForCli",
]) {
  try {
    const body = Req.encode(Req.create({})).finish();
    const res = await unaryCall(path, body, account.accessToken, config);
    console.log(`${path} -> status=${res.status} error=${res.error ?? "-"} payload=${res.payload?.length ?? 0}B`);
    if (res.payload && path.endsWith("GetUsableModels")) {
      const decoded = Res.toObject(Res.decode(res.payload), { defaults: false, enums: String, longs: Number }) as {
        models?: Array<{ modelId?: string }>;
      };
      console.log(`  models=${decoded.models?.length ?? 0}`);
      console.log(`  sample=${(decoded.models ?? []).slice(0, 6).map((m) => m.modelId).join(", ")}`);
    }
  } catch (err) {
    console.log(`${path} -> THREW ${(err as Error).message}`);
  }
}
