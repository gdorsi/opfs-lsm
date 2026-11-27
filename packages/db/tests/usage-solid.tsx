// The Solid code of the README, as an app writes it. It is compiled with the tests and never run.
import { createSignal, Errored, For, isPending, Loading } from "solid-js";
import { eq, query, type Collection } from "../src/index.js";
import { useLiveQuery } from "../src/solid.js";

type Issue = { id: string; title: string; status: number; modified: number };
declare const issues: Collection<Issue>;

const withStatus = (status: number) => query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, status)).orderBy(({ i }) => i.modified, "desc").limit(50));
const countWithStatus = (status: number) => query((q) => q.from({ i: issues }).where(({ i }) => eq(i.status, status)).count());

export function IssueList() {
  const [status, setStatus] = createSignal(1);
  const rows = useLiveQuery(() => withStatus(status()));
  const total = useLiveQuery(() => countWithStatus(status()));

  return (
    <Errored fallback={(error) => <p>{String(error())}</p>}>
      <Loading fallback={<p>Reading</p>}>
        <button onClick={() => setStatus(2)}>In progress</button>
        <p class={{ stale: isPending(total) }}>{total()} issues</p>
        <ul>
          <For each={rows()}>{(issue) => <li>{issue.title}</li>}</For>
        </ul>
      </Loading>
    </Errored>
  );
}
