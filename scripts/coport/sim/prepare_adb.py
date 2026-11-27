#!/usr/bin/env python3
"""Prepare a disposable adb executable and verify MCP routing through an isolated package."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

from mcp_client import Client
from shell_device import ShellDevice
from wire_test import isolated_host, wait_for


def prepare(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    fixture = Path(__file__).resolve().parents[1] / 'fixtures' / 'adb'
    shutil.copy2(fixture, root / 'adb')
    android = root / 'device' / 'sdcard'
    android.mkdir(parents=True, exist_ok=True)
    (android / 'seed.txt').write_bytes(b'android fixture\n')
    (android / 'fallback.bin').write_bytes(bytes(range(256)) * 3000)
    (android / 'slow-download.bin').write_bytes(b'pending file')
    (android / 'linked').symlink_to('seed.txt')
    (android / 'chain').symlink_to('linked')
    (android / 'left').mkdir()
    (android / 'right' / 'sub').mkdir(parents=True)
    (android / 'left' / 'link').symlink_to('../right/sub')
    (android / 'left' / 'left.txt').write_text('left')
    (android / 'right' / 'right.txt').write_text('right')
    write_state(root, [['one', 'device']])
    return root / 'adb'


def write_state(root, devices, **other):
    (root / 'state.json').write_text(json.dumps({'devices': devices, **other}))


def test_routes(bundle):
    with ExitStack() as stack:
        root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='cp-adb-exec-', dir='/tmp')))
        adb = prepare(root)
        os.environ['COPORT_TEST_ADB'] = str(adb)
        for key in ('ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT'):
            os.environ.pop(key, None)
        _, _, _, env = stack.enter_context(isolated_host(bundle))
        client = Client('m3-adb', env=env)
        stack.callback(client.close)
        expected = "ADB quote ' 中文"
        adb_exec = client.call('exec', {'command': f'printf "%s" "{expected}"; exit 7'})
        assert adb_exec['channel'] == 'adb' and adb_exec['output'] == expected and adb_exec['exit_code'] == 7, adb_exec
        truncated = client.call('exec', {'command': "head -c 262144 /dev/zero | tr '\\000' x", 'max_output_bytes': 1024})
        assert truncated['output_truncated'] and '261120 bytes omitted' in truncated['output'], truncated
        interrupted = client.call('exec', {'command': 'coport-ignore-term', 'timeout_ms': 1000})
        assert interrupted['error']['code'] == 'timeout', interrupted
        assert interrupted['error']['details']['interrupt'] == 'local_adb_killed', interrupted
        missing = client.call('exec', {'command': 'coport-missing-marker'})
        assert missing['error']['details'] == {'channel': 'adb', 'partial_output': 'partial'}, missing

        device = ShellDevice()
        stack.callback(device.close)
        assert device.path.startswith('/dev/ttys')
        assert not client.call('open_serial', {'path': device.path})['reused']
        assert client.call('exec', {'command': 'printf priority'})['channel'] == 'adb'

        def prompt():
            return client.call('read_terminal')['current_line'].rstrip().endswith('#')

        write_state(root, [])
        client.call('write_serial', {'data': '\r'})
        wait_for(prompt)
        time.sleep(.1)
        assert client.call('prepare_shell')['prepared']
        for devices, reason in [
            ([], None),
            ([['off', 'offline']], 'off: offline'),
            ([['locked', 'unauthorized']], 'locked: unauthorized'),
            ([], 'ADB device discovery failed'),
        ]:
            write_state(root, devices, fail_devices=reason == 'ADB device discovery failed')
            wait_for(prompt)
            outcome = client.call('exec', {'command': 'printf serial-result'})
            assert outcome['channel'] == 'serial' and outcome['output'] == 'serial-result', outcome
            if reason:
                assert outcome['adb_fallback'] == {'reason': 'adb_unavailable', 'message': reason}, outcome
            else:
                assert 'adb_fallback' not in outcome, outcome
        write_state(root, [], devices_delay=8)
        wait_for(prompt)
        start = time.monotonic()
        timed_out = client.call('exec', {'command': 'printf serial-after-adb-timeout'})
        assert 4.9 <= time.monotonic() - start < 7, timed_out
        assert timed_out['output'] == 'serial-after-adb-timeout'
        assert timed_out['adb_fallback']['reason'] == 'adb_unavailable'
        adb.rename(root / 'adb-disabled')
        wait_for(prompt)
        unavailable = client.call('exec', {'command': 'printf serial-without-adb'})
        assert unavailable['output'] == 'serial-without-adb'
        assert unavailable['adb_fallback']['message'] == 'ADB executable was not found'
        calls = [json.loads(line) for line in (root / 'adb-server.jsonl').read_text().splitlines()]
        assert calls and all(call[2] == ['-L', 'tcp:5037'] for call in calls), calls
        print(json.dumps({'adbPriority': True, 'serialFallback': True, 'offlineAndUnauthorized': True,
                          'serverFailure': True, 'adbTimeout': True, 'headTailTruncation': True,
                          'adbExitMarker': True, 'discoveryDeadline': True, 'adbMissing': True, 'defaultServerPinned': True}), flush=True)


if __name__ == '__main__':
    if sys.argv[1] == '--prepare':
        print(prepare(sys.argv[2]))
    else:
        test_routes(Path(sys.argv[1]).resolve())
