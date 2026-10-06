# Independent forwarding experiments

PathPilot has two validation layers beyond its unit tests. Both use the synthetic six-node lab in `public/labs/frr/`. Neither touches a production network.

## What has been observed

On 2026-10-06, `netns_compare.py` built six isolated Linux network namespaces in WSL2, loaded the fixture addresses and static routes into the Linux kernel, and compared route lookups and ICMP delivery with PathPilot's exported predictions. The [recorded run](evidence/kernel-observed.json) covered three allowed intents in each of three scenarios: **9 comparisons, 0 mismatches**. The unsafe route produced a branch/edge/transit forwarding loop and failed ICMP. The baseline and backup route delivered ICMP on all three allowed intents.

| Scenario | Model gate | Kernel FIB and ICMP observation |
| --- | --- | --- |
| Baseline | REVIEW | 3 allowed flows delivered; predicted paths matched |
| Route leak | BLOCK | 2 application flows looped and failed; 1 delivered |
| Safe reroute | REVIEW | 3 allowed flows delivered; predicted paths matched |

The Python namespace runner parses the supported fixture commands independently of the JavaScript importer. It configures the Linux kernel directly. **It does not run FRRouting daemons.** The recorded evidence contains the OS kernel version, timestamp, per-intent forward and return paths, packet outcomes, and mismatch list.

To repeat this on Linux or WSL2, from the repository root:

```bash
npm run emulation:expected
sudo python3 emulation/netns_compare.py
```

This requires Node.js 20+, Python 3, root/CAP_NET_ADMIN, `iproute2`, `ping`, and `sysctl`. The script creates only namespaces named for its own process and deletes them afterward. It refuses stale predictions when the lab manifest or config file hashes change.

## FRRouting/Containerlab experiment

The generator prepares the same fixtures for the [official FRRouting 10.0.1 container image](https://frrouting.org/release/10.0.1/) using [Containerlab's documented Linux node configuration mounts](https://containerlab.dev/lab-examples/peering-lab/). `observe.py` checks that FRRouting responds to `vtysh`, captures its route tables, enters the containers' network namespaces, then compares observed kernel route selections and ICMP results to the model.

**This experiment is prepared but has not been executed in this repository yet.** Docker and Containerlab were unavailable on the development host, and the configured Ubuntu package proxy prevented FRRouting installation. Only claim FRRouting validation after running the commands below and inspecting the evidence.

On a Linux Docker host with Containerlab, Python 3, Node.js 20+, `nsenter`, `iproute2`, and `ping`, run one scenario at a time from the repository root:

```bash
npm run emulation:expected
npm run emulation:prepare -- route-leak
sudo containerlab deploy --topo emulation/containerlab/runtime/route-leak/pathpilot.clab.yml
sudo python3 emulation/containerlab/observe.py route-leak
sudo containerlab destroy --topo emulation/containerlab/runtime/route-leak/pathpilot.clab.yml
```

Substitute `baseline` or `safe-reroute` for `route-leak` to run the other scenarios. Wait until FRRouting has installed the routes before observing. The observer writes `emulation/evidence/frr-SCENARIO.json`, including FRRouting route tables. A mismatch exits with status `1`; inspect the JSON before drawing conclusions. The generated runtime files are excluded from Git because the checked-in lab fixtures are the source of truth.

This experiment checks **routing and ICMP only**. The two denied TCP intents depend on stateless ACL declarations in `lab.json`; these ACLs are not installed in either Linux experiment. Latency budgets, capacity and N-1 failures are model checks, not physical measurements. An ICMP pass does not establish that a TCP application works. A `REVIEW` gate still needs human approval and validation in the target environment.
