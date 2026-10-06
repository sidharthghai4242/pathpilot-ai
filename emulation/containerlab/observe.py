#!/usr/bin/env python3
"""Observe an already-deployed PathPilot FRRouting containerlab scenario.

Run as root on the Linux Docker host. The observer enters each container's
network namespace with host iproute2/ping, and checks FRR via vtysh. This is
not part of the simulator and does not change the lab configuration.
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[2]
LAB_ROOT = ROOT / "public/labs/frr"
EXPECTED = ROOT / "emulation/expected"
RUNTIME = ROOT / "emulation/containerlab/runtime"
EVIDENCE = ROOT / "emulation/evidence"
SCENARIOS = ("baseline", "route-leak", "safe-reroute")


def command(*args, check=True, timeout=15):
    result = subprocess.run(args, text=True, capture_output=True, check=False, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get_pid(scenario, node):
    name = f"clab-pathpilot-{scenario}-{node}"
    result = command("docker", "inspect", "-f", "{{.State.Pid}}", name)
    pid = result.stdout.strip()
    if not pid.isdigit() or int(pid) <= 0:
        raise RuntimeError(f"{name} is not running")
    return pid


def trace(source, destination, pids, destination_ips, gateway_node):
    address = destination_ips[destination]
    current, path = source, []
    for _ in range(16):
        path.append(current)
        if path.count(current) > 1:
            return {"status": "LOOP", "path": path}
        if current == destination:
            return {"status": "DELIVERED", "path": path}
        result = command("nsenter", "-t", pids[current], "-n", "ip", "-j", "route", "get", address, check=False)
        if result.returncode:
            return {"status": "NO_ROUTE", "path": path, "detail": result.stderr.strip()}
        entry = json.loads(result.stdout)[0]
        gateway = entry.get("gateway")
        next_node = gateway_node.get(gateway)
        if not next_node:
            return {"status": "NO_ROUTE", "path": path, "detail": f"unmapped gateway {gateway}"}
        current = next_node
    return {"status": "TTL_EXCEEDED", "path": path}


def ping(source, destination, pids, destination_ips):
    result = command("nsenter", "-t", pids[source], "-n", "ping", "-n", "-c", "1", "-W", "2",
                     "-I", destination_ips[source], destination_ips[destination], check=False, timeout=5)
    return {"delivered": result.returncode == 0,
            "summary": next((line.strip() for line in result.stdout.splitlines() if "packets transmitted" in line), result.stderr.strip())}


def main(scenario):
    if scenario not in SCENARIOS:
        raise ValueError("scenario must be baseline, route-leak, or safe-reroute")
    if os.geteuid() != 0:
        raise ValueError("run as root to enter Docker network namespaces")
    for binary in ("docker", "nsenter", "ip", "ping"):
        if not shutil.which(binary):
            raise ValueError(f"missing required command: {binary}")
    manifest = json.loads((LAB_ROOT / "lab.json").read_text(encoding="utf-8"))
    expected = json.loads((EXPECTED / f"{scenario}.json").read_text(encoding="utf-8"))
    source = json.loads((RUNTIME / scenario / "source.json").read_text(encoding="utf-8"))
    if source["labSha256"] != sha256(LAB_ROOT / "lab.json") or expected["labSha256"] != source["labSha256"]:
        raise ValueError("lab manifest changed; regenerate expected reports and containerlab files")
    for node in manifest["nodes"]:
        node_id = node["id"]
        config = RUNTIME / scenario / node_id / "frr.conf"
        if sha256(config) != source["configSha256"][node_id] or sha256(config) != expected["configSha256"][node_id]:
            raise ValueError(f"{node_id} config changed; regenerate expected reports and containerlab files")

    pids = {node["id"]: get_pid(scenario, node["id"]) for node in manifest["nodes"]}
    ips = {node["id"]: node["ip"] for node in manifest["nodes"]}
    gateway_node = {}
    for link in manifest["links"]:
        for end in ("a", "b"):
            gateway_node[link[end]["ip"].split("/")[0]] = link[end]["node"]
    routing_tables = {}
    for node in manifest["nodes"]:
        node_id = node["id"]
        name = f"clab-pathpilot-{scenario}-{node_id}"
        routing_tables[node_id] = command("docker", "exec", name, "vtysh", "-c", "show ip route").stdout.strip()

    observations, mismatches = [], []
    for intent in manifest["intents"]:
        if intent["expectation"] != "allow":
            continue  # ACLs are not installed in this FRR routing experiment.
        prediction = next(item for item in expected["predicted"]["intents"] if item["id"] == intent["id"])
        forward = trace(intent["source"], intent["destination"], pids, ips, gateway_node)
        reverse = trace(intent["destination"], intent["source"], pids, ips, gateway_node)
        packet = ping(intent["source"], intent["destination"], pids, ips)
        observations.append({"id": intent["id"], "forward": forward, "returnRoute": reverse, "icmp": packet})
        if forward["status"] != prediction["candidateStatus"] or forward["path"] != prediction["path"]:
            mismatches.append(f'{intent["id"]}: forward FIB differs from prediction')
        if reverse["status"] != prediction["returnStatus"] or reverse["path"] != prediction["returnPath"]:
            mismatches.append(f'{intent["id"]}: return FIB differs from prediction')
        if packet["delivered"] != prediction["candidatePass"]:
            mismatches.append(f'{intent["id"]}: ICMP delivery differs from prediction')
    evidence = {
        "schemaVersion": 1,
        "observedAtUtc": datetime.now(timezone.utc).isoformat(),
        "kernel": platform.release(),
        "scenario": scenario,
        "scope": "FRRouting 10.0.1 containerlab; FRR route tables plus Linux FIB and ICMP; ACLs not installed",
        "image": source["image"],
        "labSha256": source["labSha256"],
        "configSha256": source["configSha256"],
        "modelDecision": expected["predicted"]["decision"],
        "comparison": "PASS" if not mismatches else "MISMATCH",
        "observations": observations,
        "mismatches": mismatches,
        "frrRouteTables": routing_tables,
    }
    target = EVIDENCE / f"frr-{scenario}.json"
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f'{scenario}: {len(observations)} allow intents; {len(mismatches)} mismatches; {target}')
    for mismatch in mismatches:
        print("  " + mismatch)
    return 0 if not mismatches else 1


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: sudo python3 emulation/containerlab/observe.py SCENARIO")
        sys.exit(main(sys.argv[1]))
    except Exception as error:
        print(f"FRR observation failed: {error}", file=sys.stderr)
        sys.exit(1)
