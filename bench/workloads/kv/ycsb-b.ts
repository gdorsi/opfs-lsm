import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, settlePhase, YCSB, ycsbPhase } from "../kv-lib.ts";

export default defineWorkload({
  family: "kv",
  title: YCSB.b.title,
  params: (size) => kvParams(size),
  phases: [fillPhase("load", "random"), settlePhase(), ycsbPhase("b"), settlePhase("settle-after")],
});
