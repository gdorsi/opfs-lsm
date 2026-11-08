import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, settlePhase, YCSB, ycsbPhase } from "../kv-lib.ts";

export default defineWorkload({
  family: "kv",
  title: YCSB.f.title,
  params: (size) => kvParams(size),
  phases: [fillPhase("load", "random"), settlePhase(), ycsbPhase("f"), settlePhase("settle-after")],
});
