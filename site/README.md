# Docs site

The VitePress site published at https://gdorsi.github.io/opfs-lsm/. Its home page frames a build of the [LinearLite demo](../examples/linearlite-docstore), served from the same origin under `demo/`. `pnpm docs:dev` starts both, and `pnpm docs:build` builds both into `site/.vitepress/dist`.

## Telemetry

The site and the demo send OpenTelemetry from the visitor's browser to [Everr](https://app.everr.dev). Each runs its own `WebSDK` from `@everr/otel-web`, under its own service name.

| Service | Code | Signals |
|---|---|---|
| `opfs-lsm-site` | [`.vitepress/theme/telemetry.ts`](.vitepress/theme/telemetry.ts), loaded by [`.vitepress/theme/index.ts`](.vitepress/theme/index.ts) | Errors, page views, clicks and submits, web vitals, `fetch` and XHR spans, and the errors Vue components throw. |
| `opfs-lsm-demo` | [`src/telemetry.ts`](../examples/linearlite-docstore/src/telemetry.ts) of the demo, fed by `post()` and `failed()` in [`src/protocol.ts`](../examples/linearlite-docstore/src/protocol.ts) | The same browser signals, the demo's timings, and the errors the demo catches. |

One build makes both apps, so they read the same variables. They share an origin, so they also share the visitor id and the session id the SDK keeps in `localStorage`. One visit is one session across the two services.

Telemetry is on only when `VITE_EVERR_INGEST_ENDPOINT` is set for the build or the dev server. Without it, neither app constructs a client or sends a request, and the bundler leaves the SDK out of both builds. The demo starts the SDK before its first timing. The site loads it in the browser only, as a chunk of its own, so it misses errors and clicks from before that chunk runs.

### Configuration

| Setting | Purpose | Local value | Remote value | Set in | Read at |
|---|---|---|---|---|---|
| `VITE_EVERR_INGEST_ENDPOINT` | The OTLP base URL. Unset turns telemetry off. | `<otlp-url-from-status>` | `https://ingest.everr.dev/` | The shell that builds or serves. In CI, the repository variable `EVERR_INGEST_ENDPOINT`. | Build time |
| `VITE_EVERR_PUBLIC_INGEST_KEY` | The public ingest key, sent as a bearer token. | Unset | The public key for `https://gdorsi.github.io` | In CI, the repository variable `EVERR_PUBLIC_INGEST_KEY`. | Build time |
| `VITE_EVERR_SERVICE_VERSION` | `service.version` | Unset, so the SDK's version | The commit | In CI, `github.sha`. | Build time |
| `serviceName` | `service.name` | `opfs-lsm-site`, `opfs-lsm-demo` | The same | The two `telemetry.ts` files. | Build time |
| `deploymentEnvironment` | `deployment.environment.name` | Vite's mode | `production` | The two `telemetry.ts` files. | Build time |

The endpoint alone selects where records go. A key without an endpoint turns nothing on. With an endpoint and no key, requests carry no `Authorization` header. The local collector accepts them, and the remote installation needs the key. Vite's mode is `development` for the site under `pnpm docs:dev` and `production` in every build, the demo's included, because `pnpm docs:dev` builds the demo before it serves it.

The `docs` workflow ([`.github/workflows/docs.yml`](../.github/workflows/docs.yml)) sets the three variables on its `pnpm docs:build` step for pull requests and pushes alike. Only a push to `main` deploys. A fork, or this repository without the variables, builds both apps with telemetry off.

### Events

| Event | Service | Source | Attributes |
|---|---|---|---|
| `everr.browser.page_view`, `everr.browser.page_leave` | Both | `pageviews()` | The page, and the time on it for a leave. |
| `everr.browser.interaction.click`, `everr.browser.interaction.submit` | Both | `interactions()` | A selector for the element: its tag, its stable classes and one naming attribute with its value (`aria-label`, `type`, `name`, `title` or `alt`). The `href` of the link around it. Never the element's text or a field's value. |
| `browser.web_vital`, and `slow_interaction` spans | Both | `performance()` | LCP, CLS, TTFB and INP, with their rating. |
| Client spans named after the method and path | Both | `network()` | The URL without its query, and the status. |
| `exception` | Both | `errors()`, Vue's `errorHandler` on the site, `failed()` in the demo | `exception.type`, `exception.message`, `exception.stacktrace` |
| `linearlite.open` | Demo | The `opened` message | `linearlite.duration_ms`, `linearlite.first_page_rows` (0 for an empty database, 50 at most) |
| `linearlite.first_rows` | Demo | The `first-rows` message | `linearlite.duration_ms` |
| `linearlite.filter` | Demo | The `filter` message | `linearlite.duration_ms` for the first page, `linearlite.total_duration_ms` for the count, `linearlite.total`, `linearlite.read_path` (`index`, `ranges`, `scan` or `search`) |
| `linearlite.write` | Demo | The `generated` message | `linearlite.duration_ms`, `linearlite.generate_duration_ms`, `linearlite.count` |

The demo's README defines each timing, in [Timings](../examples/linearlite-docstore/README.md#timings). Every record of the demo also carries `linearlite.framed`, `linearlite.navigation` (the frame's navigation type, such as `navigate` or `reload`), `linearlite.device.cores` and `linearlite.device.memory_gb`. The SDK adds these to every record of both services: the visitor id, the session id, the page URL, the referrer, the landing URL with its UTM parameters, the user agent, the screen size, the timezone and the language. For the demo in the frame, the referrer is the URL of the page around it.

No record holds text a visitor typed. The demo's search text stays in the `filter` message to the page, and a KPI attribute cannot hold a free string. Page URLs are sent with their query, and neither app puts visitor input in one.

### Local collector

Local collection needs no ingest key.

1. Run `everr local status`. If the collector is stopped, run `everr local start -d --no-open`. The `otlp:` line is the endpoint, and the `ui:` line opens the data.
2. Start the site with the endpoint. `pnpm dev site restart` serves the site and a fresh build of the demo:

   ```sh
   VITE_EVERR_INGEST_ENDPOINT=<otlp-url-from-status> pnpm dev site restart
   ```

   To check the production bundles instead, build and preview them:

   ```sh
   VITE_EVERR_INGEST_ENDPOINT=<otlp-url-from-status> pnpm docs:build
   pnpm docs:preview
   ```

3. Open the home page, start the demo, change a filter, and open another page of the site.
4. Query the last 10 minutes of both services:

   ```sh
   everr local query "SELECT Timestamp, ServiceName, Body FROM logs WHERE Timestamp > now() - INTERVAL 10 MINUTE AND ServiceName IN ('opfs-lsm-site', 'opfs-lsm-demo') ORDER BY Timestamp DESC LIMIT 50"
   ```

   The `Body` of an event record is its name. Query the `traces` table the same way for the spans.

### Remote installation / production

The remote installation is https://app.everr.dev. Its ingest endpoint is `https://ingest.everr.dev/`. The site is served from the origin `https://gdorsi.github.io`.

1. Mint a public key at https://app.everr.dev/api-keys with the origin `https://gdorsi.github.io`. A browser can send only with a public, origin-bound key, and a request from any other origin is refused. Origins cannot be edited later, so a new origin needs a new key.
2. In the repository's settings, under **Secrets and variables**, **Actions**, **Variables**, set `EVERR_INGEST_ENDPOINT` to `https://ingest.everr.dev/` and `EVERR_PUBLIC_INGEST_KEY` to the key. They are variables, not secrets, because the key ships in the page source. Never commit the key.
3. Push to `main`, or run the `docs` workflow again. The build reads the variables, so a change to either takes effect only in a new build. Records from a CI build carry `deployment.environment.name` set to `production` and `service.version` set to the commit.
4. Open https://gdorsi.github.io/opfs-lsm/, start the demo, and change a filter. Run `everr cloud login` if the CLI has no session, and choose the organization that owns the key. Then query the fresh records:

   ```sh
   everr cloud query "SELECT Timestamp, ServiceName, Body FROM logs WHERE Timestamp > now() - INTERVAL 10 MINUTE AND ServiceName IN ('opfs-lsm-site', 'opfs-lsm-demo') AND toString(ResourceAttributes.\`deployment.environment.name\`) = 'production' ORDER BY Timestamp DESC LIMIT 50"
   ```

   The same records show in https://app.everr.dev under the services `opfs-lsm-site` and `opfs-lsm-demo`.

To send a local run to the remote installation, set both variables in the shell and serve the build from an origin of the key. The key in use also allows `http://localhost:4173`, the port of `pnpm docs:preview`. Such a run is a production build, so its records carry `production`. Set `VITE_EVERR_SERVICE_VERSION` to tell them apart.

### Verification status

| Environment | Status |
|---|---|
| Local collector | Verified on 2026-11-19 with a production build in headless Chrome. Both services sent page views, clicks, web vitals and one `exception` per thrown error. The demo sent `linearlite.open`, `linearlite.write`, `linearlite.filter` and `linearlite.first_rows` with the values it posted to the page. |
| Remote installation | Verified on 2026-11-19 from a production build served at `http://localhost:4173`, an origin of the public key. Both services sent their browser signals, and the four demo events carried the values the demo posted to the page. |
| Production | Verified on 2026-11-19 on https://gdorsi.github.io/opfs-lsm/ at commit `333ad2d`. Both services sent their browser signals with `production` and the commit as version, and the four demo events carried the values the demo posted to the page. |
