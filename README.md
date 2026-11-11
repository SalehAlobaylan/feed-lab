# Feed Lab

Feed Lab opens Wahb's News and Pods feeds in a browser preview and records the
requests, signals, diagnostics, and outcomes that explain what appeared. It
runs as an optional local TanStack Start application on Node.

From the Wahb project root, install the Lab's dependencies. The managed
launcher then starts Feed Lab with the selected environment.

```sh
npm --prefix Feed-Lab ci
./start.sh --env ID
```

Open http://127.0.0.1:3006. Use an existing IAM operator with feed and content
read permissions. Service log excerpts also require aggregation read access.
**Quick Sign In** uses the selected environment's existing Console shortcut
credentials to open an IAM session for the selected role. Operator sign-in
opens Pods in Inspect by default. Choose **Signed in** under **Consumer** and
use **Quick Sign In** or enter an IAM email and password. The preview reloads
under the consumer session. Choosing **Anonymous** opens a fresh anonymous feed
session. Signing out the consumer also returns the preview to Anonymous.
**Inspect** uses the CMS inspection routes and keeps activity observations local.
**Test as user** sends consumer actions to the selected environment.

Open Pods or News and use the item inspector to follow the preview or open a
content ID. **Overview**, **Content**, **Journey**, **Activity**, and
**Evidence** show the captured response, current CMS state, and browser
observations. **Loaded items** jumps to a card in the captured pages.
**Pin baseline** keeps one comparison side in the open workspace as you change
consumer, mode, or filters. **Save comparison** records both sides and a note.
**Run checks** shows the exact target and supports feed, reader, and playback
checks in Inspect. Test as user adds interaction and consumption checks.
Like and bookmark checks restore the starting state by default.
When an action may have committed without a receipt, the report identifies the
uncertainty. **Save investigation** saves the selected item, evidence, and an
optional note. From **Saved runs**, open, export, or delete reports and compare
captures of the same item or story. **Run again with the same settings** opens
saved settings for review and explicit start. Saved opens articles and Pods
from the consumer's library using the same reader and player.

Reports use bounded private JSON under the project's `.eval-runs/feed-lab/`.
ZIP exports contain the JSON snapshot, generated Markdown, and selected log
attachments. Launch logs are read on demand from the managed launch directory.

The implementation adapts the owner contracts and playback patterns from
Wahb-Platform revision `0013ce29f842986ca833a62f5c3ff75d34203ead`, including
`src/lib/api/feeds.ts`, `src/lib/playback/source-resolver.ts`, and
`src/lib/experience/`. The phone pane uses the consumer Handicrafts, DM Sans,
and Playfair Display fonts and
adapts the browser feed layout in `src/components/feed/`. It reuses
`src/lib/audio-scene/scene-generator.ts` and `transcript-model.ts` from the
same revision. Wahb-Mobile revision `3752e2101f2afaa04434bd7e6e634bbe0b4a80b1`
is the layout and interaction reference for the feed header, Pods player and
action sheet, News slides, and article reader. The phone pane covers these feed
flows. Native device behavior, full profile, search, comments, and sharing are
outside its scope.

The Lab follows the Node and dotenv isolation pattern from
Platform-Console revision `cbfb898e95d768b4e8cd32e5278e5f3e366671cf` in
`vite.config.mts`. Runtime imports are local to Feed Lab.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:e2e
```

The default Playwright suite uses isolated owner response fixtures and the built
Lab. For managed qualification, start a registered disposable Neon profile
with `./start.sh --env ID --feed-lab`. Set `FEED_LAB_E2E_URL`,
`FEED_LAB_E2E_DISPOSABLE_ENV` to its ID, and `FEED_LAB_E2E_EMAIL` and
`FEED_LAB_E2E_PASSWORD` to an existing IAM operator. Provide
`FEED_LAB_E2E_CONSUMER_EMAIL` and `FEED_LAB_E2E_CONSUMER_PASSWORD` for the
signed-in write checks. Use known content with two pages of News and Pods and a
playable Pods item. Exact experience readback needs RUX collection and read
access. The managed browser tests cover rendered results, browser requests,
and CMS receipts. Use the guarded CMS inspection accounting test for database
proof and record lifecycle and cross-app session checks separately.
