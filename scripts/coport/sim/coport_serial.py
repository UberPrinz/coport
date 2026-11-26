#!/usr/bin/env python3
"""M1 main-process acceptance against two PTYs created by this process."""
import argparse
import json
import os
from pathlib import Path
import pty
import selectors
import subprocess
import tempfile
import time
import tty


def fd_count(pid, device):
    result = subprocess.run(
        ["/usr/sbin/lsof", "-a", "-p", str(pid), "-Fn", device],
        text=True, capture_output=True, timeout=5,
    )
    assert result.returncode in (0, 1), result.stderr
    return sum(line.startswith("f") and line[1:].isdigit()
               for line in result.stdout.splitlines())


def wire(master, duration):
    end = time.monotonic() + duration
    output = bytearray()
    with selectors.DefaultSelector() as io:
        io.register(master, selectors.EVENT_READ)
        while (remaining := end - time.monotonic()) > 0 and io.select(remaining):
            output.extend(os.read(master, 65536))
    return bytes(output)


def run(electron, run_dir, device, alias, second, master, scenario):
    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    script = Path(__file__).with_name("serial-core.cjs")
    with subprocess.Popen([electron, script, run_dir, device, alias, second, scenario],
                          env=env, stdout=subprocess.PIPE) as process:
        deadline = time.monotonic() + 25
        try:
            with selectors.DefaultSelector() as io:
                io.register(process.stdout, selectors.EVENT_READ)
                while True:
                    assert io.select(max(0, deadline - time.monotonic())), "Acceptance timed out"
                    line = process.stdout.readline()
                    if not line:
                        break
                    event = json.loads(line)
                    if "fd" in event:
                        expected = int(event["fd"] == "open")
                        assert fd_count(event["pid"], device) == expected, event
                    if event.get("state") == "driver-open":
                        os.write(master, b"STALE\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07")
                    if event.get("state") == "ready":
                        os.write(master, b"\x00\xffNOISE\x1b[?1000h\x1b[5n\r\n")
                    if event.get("halfLineExclusion"):
                        data = wire(master, 0.15)
                        assert data == b"\x1b[0nai\rhuman", data.hex()
                        event["deviceBytes"] = data.hex()
                    print(json.dumps(event), flush=True)
            assert process.wait(timeout=2) == 0
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("electron", help="Electron binary or packaged Coport.app for --lifecycle")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--extended", action="store_true")
    group.add_argument("--timeout", action="store_true")
    group.add_argument("--lifecycle", action="store_true")
    group.add_argument("--open-noise", action="store_true")
    group.add_argument("--history", action="store_true")
    group.add_argument("--hex-monitor", action="store_true")
    group.add_argument("--geometry", action="store_true")
    args = parser.parse_args()
    master, slave = pty.openpty()
    second_master, second_slave = pty.openpty()
    try:
        if args.lifecycle or args.hex_monitor or args.geometry:
            device = os.ttyname(slave)
            if not args.geometry:
                os.close(slave)
                slave = None
            smoke = Path(__file__).resolve().parents[1] / "smoke.mjs"
            command = ["node", smoke, args.electron, "--geometry" if args.geometry else "--lifecycle", device]
            if args.hex_monitor:
                command.append("--hex-monitor")
            with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as process:
                try:
                    run_dir = None
                    for line in process.stdout:
                        event = json.loads(line)
                        if event["case"] == "startup":
                            run_dir = Path(event["data"])
                        if event["case"].startswith("geometry-write-"):
                            os.write(master, b"\x1b[999;999H\x1b[6n\x1b[2J\x1b[H" + b"A" * 100 + b"\rB\x1b[6n")
                            response = wire(master, 0.3)
                            assert response == event["reply"].encode(), response
                            event["deviceReceivedHex"] = response.hex()
                            if event["case"] == "geometry-write-ai":
                                # Keep the Darwin PTY alive across the gap between generations.
                                os.close(slave)
                                slave = None
                            (run_dir / event["case"]).touch()
                            line = json.dumps(event)
                        if event["case"] == "profile-before-attach":
                            os.write(master, b"COPORT-LOGIN\r\n")
                        if event["case"] == "profile-open":
                            mode = b"" if args.hex_monitor else b"\x1b[?1000h\x1b[?1006h\x1b[?1004h"
                            os.write(master, b"COPORT-SNAPSHOT" + mode + b"\x1b[5n\r\n")
                        if event["case"] == "profile-output-acked":
                            response = wire(master, 0.15)
                            expected = b"" if args.hex_monitor else b"login-once\n\x1b[0n"
                            assert response == expected, f"Unexpected terminal response {response.hex()}"
                            event["deviceReceivedBytes"] = len(response)
                            event["deviceReceivedHex"] = response.hex()
                            line = json.dumps(event)
                        if event["case"] == "mcp-detached-write":
                            response = wire(master, 0.15)
                            assert response == b"MCP-DETACHED\r", response
                            os.write(master, b"MCP-DETACHED-OUTPUT\r\n")
                            event["deviceReceivedHex"] = response.hex()
                            line = json.dumps(event)
                        if event["case"] == "profile-reopened":
                            response = wire(master, 0.15)
                            assert not response, f"Reopen repeated login bytes {response.hex()}"
                            event["repeatLoginBytes"] = 0
                            line = json.dumps(event)
                        print(line.rstrip(), flush=True)
                    assert process.wait(timeout=5) == 0
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
            return
        with tempfile.TemporaryDirectory(prefix="coport-m1-") as directory:
            root = Path(directory)
            alias = root / "serial-alias"
            device = os.ttyname(slave)
            alias.symlink_to(device)
            scenario = next(name for name in ("extended", "timeout", "history", "open_noise") if getattr(args, name))
            if scenario in ("extended", "open_noise"):
                tty.setraw(second_slave)
                os.write(second_master, b"OLD-OUTPUT\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07")
            run(args.electron, root, device, alias, os.ttyname(second_slave), second_master, scenario)
    finally:
        for fd in (master, slave, second_master, second_slave):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    main()
