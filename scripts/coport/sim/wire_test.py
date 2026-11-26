#!/usr/bin/env python3
"""MCP protocol and socket checks against the packaged Coport and a private PTY."""
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

import mcp_client
from mcp_client import Client


def wait_for(condition, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if result := condition():
            return result
        time.sleep(.02)
    raise AssertionError("Coport fixture timed out")


def result(client, name, arguments=None, **options):
    response = client.request("tools/call", {"name": name, "arguments": arguments or {}}, **options)
    response["content"][0]["text"] = json.loads(response["content"][0]["text"])
    assert response["content"][0]["text"] == response["structuredContent"], response
    return response


def accepted(endpoint):
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(2)
    client.connect(str(endpoint))
    return client


def rejected(endpoint):
    with accepted(endpoint) as connection:
        try:
            assert connection.recv(1) == b"", "the seventeenth connection stayed open"
        except ConnectionResetError:
            pass


def check_socket(bundle, directory, endpoint, pid, env):
    for path, kind, mode in [(endpoint, stat.S_ISSOCK, 0o600), (directory, stat.S_ISDIR, 0o700)]:
        info = path.lstat()
        print(json.dumps({"path": str(path), "uid": info.st_uid, "gid": info.st_gid,
                          "mode": format(stat.S_IMODE(info.st_mode), "04o")}), flush=True)
        assert kind(info.st_mode)
        assert info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == mode
    output = subprocess.run(["/usr/sbin/lsof", "-iTCP", "-iUDP", "-a", "-p", str(pid)],
                            capture_output=True, text=True)
    assert output.returncode == 1 and not output.stdout, output.stdout
    connections = []
    try:
        for index in range(16):
            client = accepted(endpoint)
            connections.append(client)
            request = {'jsonrpc': '2.0', 'id': index, 'method': 'initialize', 'params': {
                'protocolVersion': '2025-06-18', 'capabilities': {},
                'clientInfo': {'name': 'coport-limit', 'version': '1'},
            }}
            client.sendall(json.dumps(request).encode() + b'\n')
            with client.makefile('rb') as response:
                assert json.loads(response.readline())['result']['serverInfo']['name'] == 'Coport'
        rejected(endpoint)
    finally:
        for connection in connections:
            connection.close()

    # The production listener must be preserved if a second isolated app sees it.
    with tempfile.TemporaryDirectory(prefix='cp-occupied-', dir='/tmp') as data:
        startup = subprocess.run([str(bundle/'Contents/MacOS/Coport'), '--coport-background',
                                  '--user-data-dir=' + data], env=env, capture_output=True, text=True, timeout=12)
        assert startup.returncode == 1 and 'EADDRINUSE' in startup.stderr + startup.stdout, startup
    assert endpoint.is_socket()
    print(json.dumps({"socketMode": "0600", "parentMode": "0700", "limit": 16,
                      "tcpUdpListeners": 0, "liveSocketPreserved": True}), flush=True)



FOREIGN_UID_CLIENT = """
import os
import socket
import sys

assert os.getuid() != int(sys.argv[2])
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(2)
    client.connect(sys.argv[1])
    try:
        assert client.recv(1) == b'', 'foreign peer was accepted'
    except ConnectionResetError:
        pass
"""


def check_foreign_peer(directory, endpoint):
    # Temporarily pass Darwin's file-mode gate on this isolated endpoint so the
    # listener's own peer-credential check has a chance to reject the connection.
    try:
        directory.chmod(0o711)
        endpoint.chmod(0o666)
        subprocess.run(['/usr/bin/sudo', '-n', '-u', 'nobody', '/usr/bin/python3', '-c',
                        FOREIGN_UID_CLIENT, str(endpoint), str(os.getuid())], check=True, timeout=8)
        print(json.dumps({'foreignUidClosed': True}), flush=True)
    finally:
        endpoint.chmod(0o600)
        directory.chmod(0o700)

def check_tools(env, directory, pid):
    fixture = json.loads(Path(__file__).with_name('swift-mcp.json').read_text())
    with_clients = []
    master, slave = pty.openpty()
    second_master, second_slave = pty.openpty()
    device = os.ttyname(slave)
    second_device = os.ttyname(second_slave)
    assert device.startswith('/dev/ttys')
    os.set_blocking(master, False)
    try:
        client = Client("coport-m2-wire", env=env)
        with_clients.append(client)
        assert client.request('tools/list')['tools'] == fixture["tools"]
        samples = {
            "read_terminal": {"max_lines": 1},
            "write_serial": {"data": "probe\r"},
            "exec": {"command": ""},
            "get_view_state": {},
            "prepare_shell": {},
            "open_serial": {},
        }
        for sample in fixture["calls"]:
            expected = sample["result"]
            expected["content"][0]["text"] = json.loads(expected["content"][0]["text"])
            assert result(client, sample["name"], samples[sample["name"]], fragment=True) == expected
        for arguments in [[], "bad", 42, True]:
            assert client.call("read_terminal", arguments)["error"]["code"] == "invalid_argument"
        assert client.call("read_terminal", {"after_line": None})["error"]["code"] == "invalid_argument"

        alias = directory/"alias"
        alias.symlink_to(device)
        opening = client.call("open_serial", {"path": str(alias)})
        generation = opening["session_id"]
        assert opening == {"session_id": generation, "path": device, "reused": False}
        observer = Client("coport-m2-observer", env=env, options=("--tabby",))
        with_clients.append(observer)
        assert observer.call("write_serial", {"data": "unbound\r"})["error"]["code"] == "no_serial"
        assert observer.call("open_serial", {"path": device}) == {**opening, "reused": True}
        fds = subprocess.check_output(["/usr/sbin/lsof", "-a", "-p", str(pid), "-Fn", device], text=True)
        assert sum(line[1:].isdigit() for line in fds.splitlines() if line.startswith("f")) == 1, fds
        conflict = fixture["config_conflict"]
        conflict["content"][0]["text"] = json.loads(conflict["content"][0]["text"])
        assert result(client, "open_serial", {"path": str(alias), "baud": 9600}) == conflict

        assert client.call("write_serial", {"data": "half"}) == {"bytes_queued": 4}
        def captured():
            try:
                return os.read(master, 65536)
            except BlockingIOError:
                return None
        assert wait_for(captured) == b"half"
        assert client.call("open_serial", {"path": second_device})["path"] == second_device
        assert client.call("open_serial", {"path": device}) == {**opening, "reused": True}
        assert client.call("write_serial", {"data": "-same-client"}) == {"bytes_queued": 12}
        assert wait_for(captured) == b"-same-client"
        assert client.call("open_serial", {"path": second_device})["reused"]
        # EOF must orphan A's pending input while the connection is bound to B.
        start = time.monotonic()
        client.process.kill()
        client.process.wait(timeout=.2)
        blocked = observer.call("write_serial", {"data": "no splice\r"}, timeout=.2)
        elapsed = (time.monotonic() - start) * 1000
        assert elapsed < 200 and blocked["error"]["code"] == "busy", blocked
        assert captured() is None
        assert observer.call("write_serial", {"data": "03", "encoding": "hex"}) == {"bytes_queued": 1}
        assert wait_for(captured) == b"\x03"
        os.write(master, b"\x1b]133;D;130\x07\x1b]133;A\x07# \x1b]133;B\x07")
        assert wait_for(lambda: observer.call("read_terminal")["current_line"] == "#")
        assert observer.call("write_serial", {"data": "resumed\r"}) == {"bytes_queued": 8}
        assert wait_for(captured) == b"resumed\r"

        before = observer.call("read_terminal")["last_line"]
        observer.sequence += 1
        pending = observer.sequence
        observer.send({"jsonrpc": "2.0", "id": pending, "method": "tools/call",
                       "params": {"name": "read_terminal", "arguments": {"after_line": before, "wait_ms": 1500}}})
        start = time.monotonic()
        assert observer.call("get_view_state") == {"log": None}
        assert time.monotonic() - start < 1
        os.write(master, b"\r\nCOPORT-WIRE-HISTORY\r\n")
        page = observer.call("read_terminal", {"after_line": before, "wait_ms": 1000})
        assert page["lines"][-1]["text"] == "COPORT-WIRE-HISTORY", page

        # Leave the PTY unread until the OS and serial queue are both full.
        enqueued = 0
        for size in (65536 >> shift for shift in range(17)):
            while True:
                received = observer.call("write_serial", {"data": "q" * size})
                if "error" in received:
                    assert received["error"]["code"] == "queue_full", received
                    break
                enqueued += received["bytes_queued"]
                assert enqueued < 131072, "PTY did not apply backpressure"
        os.write(master, b"\x1b[6n" * 40)
        time.sleep(.15)
        written = bytearray()

        def all_replies():
            data = captured()
            if data:
                written.extend(data)
            return re.fullmatch(rb"(?:\x1b\[\d+;\d+R){40}", written[enqueued:])

        wait_for(all_replies, seconds=3)
        assert written[:enqueued] == b"q" * enqueued

        print(json.dumps({"tools": list(samples), "swiftFieldParity": True, "fragmented": True,
                          "configConflict": True, "aliasFds": 1, "orphanBlockedMs": round(elapsed, 2),
                          "rebindKeepsSameOwner": True,
                          "longPollConcurrent": True, "terminalRepliesUnderBackpressure": 40}), flush=True)
    finally:
        for client in with_clients:
            client.close()
        os.close(second_slave)
        os.close(second_master)
        os.close(slave)
        os.close(master)


@contextmanager
def isolated_host(bundle):
    mcp_client.SHIM = bundle/'Contents/MacOS/coport-mcp'
    with tempfile.TemporaryDirectory(prefix='cp-wire-', dir='/tmp') as work:
        directory = Path(work).resolve()
        endpoint = directory/'mcp.sock'
        env = dict(os.environ, COPORT_TEST_SOCKET=str(endpoint), TABBY_PLUGINS='')
        for key in ('COPORT_TEST_AUTOSTART_APP', 'ELECTRON_RUN_AS_NODE', 'TABBY_DEV'):
            env.pop(key, None)
        # Create an owned stale inode before launching the app.
        with socket.socket(socket.AF_UNIX) as stale:
            stale.bind(str(endpoint))
        with (directory/'startup.log').open('w+') as log:
            process = subprocess.Popen([str(bundle/'Contents/MacOS/Coport'), '--coport-background',
                                        '--user-data-dir=' + str(directory)], env=env, stdout=log, stderr=log)
            try:
                wait_for(lambda: endpoint.is_socket() and stat.S_IMODE(endpoint.stat().st_mode) == 0o600)
                yield directory, endpoint, process.pid, env
            except BaseException:
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def write_group(first_id, payload_bytes=60000):
    return [
        {'jsonrpc': '2.0', 'id': index, 'method': 'tools/call', 'params': {
            'name': 'write_serial', 'arguments': {'data': 'a0' * payload_bytes, 'encoding': 'hex'},
        }}
        for index in range(first_id, first_id + 5)
    ]


def check_legacy_batch(endpoint):
    with accepted(endpoint) as connection, connection.makefile('rb') as response:
        def send(message):
            connection.sendall(json.dumps(message).encode() + b'\n')

        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'legacy-batch', 'version': '1'},
        }})
        assert json.loads(response.readline())['result']['protocolVersion'] == '2025-03-26'
        send([
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'},
        ])
        batch = json.loads(response.readline())
        assert [reply['id'] for reply in batch] == [2, 3], batch
        assert len(batch[0]['result']['tools']) == 6 and batch[1]['result'] == {}, batch
        send([])
        assert json.loads(response.readline())['error'] == {
            'code': -32600, 'message': 'Invalid Request: Batch array must not be empty',
            'data': {'detail': 'Batch array must not be empty'},
        }
        for invalid_item in [7, {'jsonrpc': '2.0', 'id': 99, 'result': {}}]:
            send([{'jsonrpc': '2.0', 'id': 4, 'method': 'ping'}, invalid_item])
            assert json.loads(response.readline())['error'] == {
                'code': -32700, 'message': 'Parse error: Invalid JSON: Invalid message format',
                'data': {'detail': 'Invalid message format'},
            }
        master, slave = pty.openpty()
        second_master, second_slave = pty.openpty()
        try:
            device = os.ttyname(slave)
            assert device.startswith('/dev/ttys')
            cancelled_batch = [
                {'jsonrpc': '2.0', 'id': 5, 'method': 'tools/call', 'params': {
                    'name': 'open_serial', 'arguments': {'path': device},
                }},
                {'jsonrpc': '2.0', 'id': 6, 'method': 'ping'},
            ]
            cancellation = {'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                            'params': {'requestId': 5}}
            connection.sendall((json.dumps(cancelled_batch) + '\n' + json.dumps([cancellation]) + '\n').encode())
            replies = json.loads(response.readline())
            assert [reply['id'] for reply in replies] == [5, 6], replies
            assert replies[0]['result']['structuredContent']['path'] == device

            second = os.ttyname(second_slave)
            assert second.startswith('/dev/ttys')
            rebind_batch = [{'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {
                'name': 'open_serial', 'arguments': {'path': second},
            }}]
            write_batch = [{'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call', 'params': {
                'name': 'write_serial', 'arguments': {'data': 'second-device\r'},
            }}]
            connection.sendall((json.dumps(rebind_batch) + '\n' + json.dumps(write_batch) + '\n').encode())
            assert [json.loads(response.readline())[0]['id'] for _ in range(2)] == [7, 8]
            ready, _, _ = select.select([master, second_master], [], [], 2)
            assert ready == [second_master] and os.read(second_master, 1024) == b'second-device\r'
            assert not select.select([master], [], [], .05)[0]

            long_poll = [{'jsonrpc': '2.0', 'id': 9, 'method': 'tools/call', 'params': {
                'name': 'read_terminal', 'arguments': {'after_line': -1, 'wait_ms': 500},
            }}]
            for requests in (long_poll, write_group(10), write_group(15)):
                send(requests)
            assert [[r['id'] for r in json.loads(response.readline())] for _ in range(3)] == [
                [9], list(range(10, 15)), list(range(15, 20)),
            ]
        finally:
            os.close(second_slave)
            os.close(second_master)
            os.close(slave)
            os.close(master)
        print(json.dumps({'legacyBatch': '2025-03-26', 'responses': len(batch),
                          'invalidBatchesAnswered': True, 'lateCancellationDoesNotStallBatch': True,
                          'pipelinedBatchWritesToReboundDevice': True,
                          'twoLargeQueuedFrames': True}), flush=True)


def check_saturated_disconnect(endpoint):
    with ExitStack() as stack:
        connection = stack.enter_context(accepted(endpoint))
        response = stack.enter_context(connection.makefile('rb'))
        master, slave = pty.openpty()
        stack.callback(os.close, master)
        stack.callback(os.close, slave)
        device = os.ttyname(slave)
        assert device.startswith('/dev/ttys')

        def send(message):
            connection.sendall(json.dumps(message).encode() + b'\n')

        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'disconnect-batch', 'version': '1'},
        }})
        assert json.loads(response.readline())['result']['protocolVersion'] == '2025-03-26'
        send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
            'name': 'open_serial', 'arguments': {'path': device},
        }})
        assert json.loads(response.readline())['result']['structuredContent']['path'] == device
        send([
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {
                'name': 'read_terminal', 'arguments': {'after_line': -1, 'wait_ms': 750},
            }},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {
                'name': 'write_serial', 'arguments': {'data': 'must-not-write\r'},
            }},
        ])
        send_started = time.monotonic()
        send(write_group(10, 53000))
        send(write_group(15, 53000))
        start = time.monotonic()
        assert start - send_started < .5, 'fixture sent FIN after the active batch completed'
        connection.shutdown(socket.SHUT_WR)
        connection.settimeout(.2)
        try:
            first = response.read(1)
            assert first == b'', (time.monotonic() - start, first + response.readline())
        except ConnectionResetError:
            pass
        elapsed_ms = (time.monotonic() - start) * 1000
        assert elapsed_ms < 200, elapsed_ms
        assert not select.select([master], [], [], 1)[0], 'queued batch wrote to the PTY after EOF'
        print(json.dumps({'saturatedDisconnectMs': round(elapsed_ms, 2), 'postEofWrites': 0}), flush=True)


def check_session_limit(env):
    with ExitStack() as stack:
        client = Client("coport-m2-session-limit", env=env)
        stack.callback(client.close)
        paths = []
        for _ in range(17):
            master, slave = pty.openpty()
            stack.callback(os.close, master)
            stack.callback(os.close, slave)
            path = os.ttyname(slave)
            assert path.startswith('/dev/ttys')
            paths.append(path)
        for path in paths[:16]:
            assert client.call('open_serial', {'path': path})['reused'] is False
        assert client.call('open_serial', {'path': paths[16]}) == {
            'error': {'code': 'queue_full', 'message': 'Shared serial queue is full', 'retryable': True},
        }
        assert client.call('open_serial', {'path': paths[0]})['reused'] is True
        print(json.dumps({'sessionLimit': 16, 'reuseAtLimit': True}), flush=True)


def main():
    bundle = Path(sys.argv[1]).resolve()
    with isolated_host(bundle) as (directory, endpoint, pid, env):
        check_socket(bundle, directory, endpoint, pid, env)
        check_tools(env, directory, pid)
        check_legacy_batch(endpoint)
        check_saturated_disconnect(endpoint)
        if "--foreign-uid" in sys.argv[2:]:
            check_foreign_peer(directory, endpoint)
    with isolated_host(bundle) as (_, _, _, env):
        check_session_limit(env)


if __name__ == "__main__":
    main()
