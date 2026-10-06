#!/usr/bin/env python3
"""Compare PathPilot predictions with the Linux kernel forwarding plane.

Root, iproute2, ping, and Python 3 are required. This experiment does not run
FRRouting daemons or model ACLs; it loads the same static-route subset into
isolated namespaces and independently observes kernel route selection and ICMP.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
LAB_ROOT = ROOT / "public/labs/frr"
EXPECTED = ROOT / "emulation/expected"
EVIDENCE = ROOT / "emulation/evidence/kernel-observed.json"
SCENARIOS = ("baseline", "route-leak", "safe-reroute")
ALLOWED_META = ("frr version", "frr defaults", "hostname", "service integrated-vtysh-config", "log stdout", "line vty")


def command(*args, check=True, timeout=15):
    result = subprocess.run(args, text=True, capture_output=True, check=False, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def config_path(scenario, node):
    candidate = LAB_ROOT / "candidates" / scenario / f"{node}.conf"
    return candidate if candidate.exists() else LAB_ROOT / "baseline" / f"{node}.conf"


def parse_config(path):
    """Independent strict parser for the fixture subset used by this experiment."""
    addresses = {}
    routes = []
    current = None
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line == "!":
            if line == "!":
                current = None
            continue
        if line.startswith(ALLOWED_META):
            current = None
            continue
        if line == "exit":
            current = None
            continue
        match = re.fullmatch(r"interface ([A-Za-z][A-Za-z0-9_.-]*)", line)
        if match:
            current = match.group(1)
            if current in addresses:
                raise ValueError(f"{path}:{number}: duplicate interface")
            addresses[current] = []
            continue
        match = re.fullmatch(r"ip address (\d{1,3}(?:\.\d{1,3}){3}/\d{1,2})", line)
        if match and current:
            addresses[current].append(str(ipaddress.ip_interface(match.group(1))))
            continue
        match = re.fullmatch(r"ip route (\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}) (\d{1,3}(?:\.\d{1,3}){3})(?: (\d{1,3}))?", line)
        if match and not current:
            prefix = str(ipaddress.ip_network(match.group(1), strict=True))
            gateway = str(ipaddress.ip_address(match.group(2)))
            distance = int(match.group(3) or "1")
            if not 1 <= distance <= 255:
                raise ValueError(f"{path}:{number}: invalid distance")
            routes.append((prefix, gateway, distance))
            continue
        raise ValueError(f"{path}:{number}: unsupported command: {line}")
    return addresses, routes


class NamespaceLab:
    def __init__(self, manifest, configs):
        self.manifest = manifest
        self.configs = configs
        self.prefix = f"pp{os.getpid()}-"
        self.created = []
        self.names = {node["id"]: self.prefix + node["id"] for node in manifest["nodes"]}
        self.gateway_node = {}
        for link in manifest["links"]:
            self.gateway_node[link["a"]["ip"].split("/")[0]] = link["a"]["node"]
            self.gateway_node[link["b"]["ip"].split("/")[0]] = link["b"]["node"]

    def __enter__(self):
        try:
            for node in self.manifest["nodes"]:
                name = self.names[node["id"]]
                command("ip", "netns", "add", name)
                self.created.append(name)
                command("ip", "-n", name, "link", "set", "lo", "up")
                command("ip", "-n", name, "addr", "add", f'{node["ip"]}/32', "dev", "lo")
                for key in ("net.ipv4.ip_forward=1", "net.ipv4.conf.all.rp_filter=0",
                            "net.ipv4.conf.default.rp_filter=0", "net.ipv4.conf.all.send_redirects=0"):
                    command("ip", "netns", "exec", name, "sysctl", "-q", "-w", key)
            for index, link in enumerate(self.manifest["links"]):
                first, second = link["a"], link["b"]
                va, vb = f"p{os.getpid() % 100000:05d}{index:02d}a", f"p{os.getpid() % 100000:05d}{index:02d}b"
                command("ip", "link", "add", va, "type", "veth", "peer", "name", vb)
                command("ip", "link", "set", va, "netns", self.names[first["node"]])
                command("ip", "link", "set", vb, "netns", self.names[second["node"]])
                for endpoint, temporary in ((first, va), (second, vb)):
                    ns = self.names[endpoint["node"]]
                    command("ip", "-n", ns, "link", "set", temporary, "name", endpoint["iface"])
                    command("ip", "-n", ns, "addr", "add", endpoint["ip"], "dev", endpoint["iface"])
                    command("ip", "-n", ns, "link", "set", endpoint["iface"], "up")
                    command("ip", "netns", "exec", ns, "sysctl", "-q", "-w",
                            f'net.ipv4.conf.{endpoint["iface"]}.rp_filter=0')
                    command("ip", "netns", "exec", ns, "sysctl", "-q", "-w",
                            f'net.ipv4.conf.{endpoint["iface"]}.send_redirects=0')
            for node in self.manifest["nodes"]:
                node_id = node["id"]
                addresses, routes = parse_config(self.configs[node_id])
                expected = {"lo": [f'{node["ip"]}/32']}
                for link in self.manifest["links"]:
                    for side in ("a", "b"):
                        endpoint = link[side]
                        if endpoint["node"] == node_id:
                            expected[endpoint["iface"]] = [endpoint["ip"]]
                if addresses != expected:
                    raise ValueError(f"{node_id}: config addresses differ from the lab manifest")
                for prefix, gateway, distance in routes:
                    command("ip", "-n", self.names[node_id], "route", "add", prefix,
                            "via", gateway, "metric", str(distance))
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, _kind, _value, _traceback):
        for name in reversed(self.created):
            command("ip", "netns", "delete", name, check=False)
        self.created.clear()

    def fib_trace(self, source, destination):
        address = next(node["ip"] for node in self.manifest["nodes"] if node["id"] == destination)
        current, path = source, []
        for _ in range(16):
            path.append(current)
            if path.count(current) > 1:
                return {"status": "LOOP", "path": path}
            if current == destination:
                return {"status": "DELIVERED", "path": path}
            result = command("ip", "netns", "exec", self.names[current], "ip", "-j", "route", "get", address, check=False)
            if result.returncode:
                return {"status": "NO_ROUTE", "path": path, "detail": result.stderr.strip()}
            entry = json.loads(result.stdout)[0]
            gateway = entry.get("gateway")
            next_node = self.gateway_node.get(gateway)
            if not next_node:
                return {"status": "NO_ROUTE", "path": path, "detail": f"unmapped gateway {gateway}"}
            current = next_node
        return {"status": "TTL_EXCEEDED", "path": path}

    def ping(self, source, destination):
        source_ip = next(node["ip"] for node in self.manifest["nodes"] if node["id"] == source)
        dest_ip = next(node["ip"] for node in self.manifest["nodes"] if node["id"] == destination)
        result = command("ip", "netns", "exec", self.names[source], "ping", "-n", "-c", "1", "-W", "2",
                         "-I", source_ip, dest_ip, check=False, timeout=5)
        return {"delivered": result.returncode == 0,
                "summary": next((line.strip() for line in result.stdout.splitlines() if "packets transmitted" in line), result.stderr.strip())}


def run_scenario(manifest, name):
    expected = json.loads((EXPECTED / f"{name}.json").read_text(encoding="utf-8"))
    if expected["labSha256"] != digest(LAB_ROOT / "lab.json"):
        raise ValueError(f"{name}: stale manifest fingerprint; regenerate expected reports")
    configs = {node["id"]: config_path(name, node["id"]) for node in manifest["nodes"]}
    for node_id, path in configs.items():
        if expected["configSha256"][node_id] != digest(path):
            raise ValueError(f"{name}: stale config fingerprint for {node_id}; regenerate expected reports")
    observations = []
    mismatches = []
    with NamespaceLab(manifest, configs) as lab:
        for intent in manifest["intents"]:
            if intent["expectation"] != "allow":
                continue  # Manifest ACLs are not installed in this routing-only experiment.
            prediction = next(item for item in expected["predicted"]["intents"] if item["id"] == intent["id"])
            forward = lab.fib_trace(intent["source"], intent["destination"])
            reverse = lab.fib_trace(intent["destination"], intent["source"])
            packet = lab.ping(intent["source"], intent["destination"])
            observed = {"id": intent["id"], "forward": forward, "returnRoute": reverse, "icmp": packet}
            observations.append(observed)
            if forward["status"] != prediction["candidateStatus"] or forward["path"] != prediction["path"]:
                mismatches.append(f'{intent["id"]}: forward FIB differs from prediction')
            if reverse["status"] != prediction["returnStatus"] or reverse["path"] != prediction["returnPath"]:
                mismatches.append(f'{intent["id"]}: return FIB differs from prediction')
            if packet["delivered"] != prediction["candidatePass"]:
                mismatches.append(f'{intent["id"]}: ICMP delivery differs from prediction')
    return {"scenario": name, "modelDecision": expected["predicted"]["decision"],
            "observations": observations, "mismatches": mismatches}


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run as root; network namespaces require CAP_NET_ADMIN")
    for binary in ("ip", "ping", "sysctl"):
        if not shutil.which(binary):
            raise SystemExit(f"Missing required command: {binary}")
    manifest = json.loads((LAB_ROOT / "lab.json").read_text(encoding="utf-8"))
    results = [run_scenario(manifest, name) for name in SCENARIOS]
    evidence = {
        "schemaVersion": 1,
        "observedAtUtc": datetime.now(timezone.utc).isoformat(),
        "kernel": platform.release(),
        "scope": "Linux network namespaces; static routes independently parsed from FRR fixtures into kernel FIB; ACLs and FRR daemons not included",
        "comparison": "PASS" if all(not item["mismatches"] for item in results) else "MISMATCH",
        "scenarios": results,
    }
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    for item in results:
        print(f'{item["scenario"]}: {len(item["observations"])} allow intents; {len(item["mismatches"])} mismatches')
        for mismatch in item["mismatches"]:
            print("  " + mismatch)
    print(f'Wrote {EVIDENCE}')
    return 0 if evidence["comparison"] == "PASS" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Emulation failed: {error}", file=sys.stderr)
        sys.exit(1)
