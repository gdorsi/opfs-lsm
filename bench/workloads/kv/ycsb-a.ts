import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, settlePhase, YCSB, ycsbPhase } from "../kv-lib.ts";

/** YCSB A, then YCSB F on the same keys after a settle: zipfian reads with blind updates, then with read-modify-writes. */
export default defineWorkload({
  family: "kv",
  title: `${YCSB.a.title}; then ${YCSB.f.title}; zipfian`,
  owns: ["kv-zipfian-update", "kv-rmw"],
  params: (size) => kvParams(size),
  phases: [fillPhase("load", "random"), settlePhase(), ycsbPhase("a"), settlePhase("settle-a"), ycsbPhase("f"), settlePhase("settle-after")],
});
