# How to use PathPilot AI

## 1. Start the local demo

Install Node.js 20 or newer. Open PowerShell in the cloned repository:

```powershell
npm run check
npm start
```

Open `http://localhost:3000`. If port 3000 is occupied, set another port before starting:

```powershell
$env:PORT = '3002'
npm start
```

`npm run check` runs syntax checks and 23 automated tests. The deterministic demo needs no API key or `npm install`.

## 2. Use the browser lab

1. Scroll to **FRRouting snapshot lab**.
2. Select **Load route loop**. The proposed route sends application traffic from `edge` toward `internet`; the transit node sends it back. Read the **BLOCK** result, the affected `LAB-01` and `LAB-03` intents, and their hop paths.
3. Select **Load backup route**. Its next hop is the adjacent application backup link. All five modeled intents hold, so the result is **REVIEW**, with human approval required.
4. Edit **Route proposal JSON** and select **Run safety gate**. Try setting `gateway` to `192.0.2.1` to see a nonadjacent next hop rejected before simulation. Load a preset again to restore it.
5. In the introductory dashboard above the lab, choose the ACL and link-failure scenarios, click an intent row, and inspect the packet walk and N-1 failure cards.

The browser uses the same core parser and safety gate as the CLI. It never touches a live network.

## 3. Use the CLI as a change gate

From the project folder, run a proposed route:

```powershell
node cli.js verify --lab public/labs/frr/lab.json --baseline public/labs/frr/baseline --proposal public/labs/frr/proposals/route-leak.json --provenance ai --json
```

Then run the reviewable example:

```powershell
node cli.js verify --lab public/labs/frr/lab.json --baseline public/labs/frr/baseline --proposal public/labs/frr/proposals/safe-reroute.json --provenance ai --json
```

The exit codes are `2` for **BLOCK**, `0` for **REVIEW**, and `1` for invalid input. The JSON contains route differences, intent results, paths, regressions, and N-1 link impact. To save it, add `--out report.json`.

To compare configuration snapshots instead of a proposal, use `--candidate public/labs/frr/candidates/route-leak` in place of `--proposal ...`. Unchanged node configs are inherited from the baseline directory.

## 4. Optional AI path

The **Ask AI, then verify** button requires the Node server and a server-side `OPENAI_API_KEY`. AI can propose one to three constrained static-route additions; local validation and the deterministic gate still decide. A static GitHub Pages deployment provides the deterministic browser lab but not live AI generation.

The provider adapter has been tested with fake responses. Live provider behavior has not been verified in this project without a key. Never put an API key in `public/` or the repository.
