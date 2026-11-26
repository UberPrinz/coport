"""Compare original Swift MCP wire samples with an Electron SDK transport."""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


SAMPLES = {
    'read_terminal': {'max_lines': 1},
    'write_serial': {'data': 'probe\r'},
    'exec': {'command': ''},
    'get_view_state': {},
    'prepare_shell': {},
    'open_serial': {},
}


@contextmanager
def child(command, **kwargs):
    with subprocess.Popen(command, **kwargs) as process:
        try:
            yield process
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)


def wait_socket(endpoint, process):
    end = time.monotonic() + 8
    while not endpoint.is_socket():
        assert process.poll() is None, process.returncode
        assert time.monotonic() < end, endpoint
        time.sleep(.02)


def snapshot(client):
    tools = client.request('tools/list')['tools']
    assert {tool['name'] for tool in tools} == set(SAMPLES)
    calls = []
    for name, args in SAMPLES.items():
        result = client.request('tools/call', {'name': name, 'arguments': args}, fragment=True)
        assert json.loads(result['content'][0]['text']) == result['structuredContent']
        assert result['isError'] == ('error' in result['structuredContent'])
        calls.append({'name': name, 'result': result})
    return {'tools': tools, 'calls': calls}


def compatible(actual, expected):
    for call in (*actual['calls'], *expected['calls']):
        # String serialization can order keys differently, but all fields and
        # values in both the MCP content and structuredContent must match.
        for content in call['result']['content']:
            content['text'] = json.loads(content['text'])
    assert actual == expected, (actual, expected)


def run(electron, source, packaged):
    spec = importlib.util.spec_from_file_location('mcp_client', source / 'scripts/sim/mcp_client.py')
    client_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client_module)
    client_module.SHIM = packaged / 'Contents/MacOS/coport-mcp'

    with tempfile.TemporaryDirectory(dir='dist/coport-m0', prefix='p3-') as temp:
        work = Path(temp).resolve()
        swift, sdk, tabby = (work / name for name in ('swift.sock', 'sdk.sock', 'tabby.sock'))
        assert all(len(os.fsencode(endpoint)) < 104 for endpoint in (swift, sdk, tabby))
        fake_adb = work / 'adb'
        shutil.copy2(source / 'scripts/fixtures/adb', fake_adb)
        (work / 'state.json').write_text('{"devices":[]}')
        env = dict(
            os.environ,
            COPORT_TEST_SOCKET=str(swift),
            COPORT_TEST_TABBY_SOCKET=str(tabby),
            COPORT_TEST_TABBY_APP='/usr/bin/false',
            COPORT_TEST_DEFAULTS_DOMAIN='local.coport.test.m0.' + str(uuid.uuid4()),
            COPORT_TEST_CACHE_ROOT=str(work / 'cache'),
            COPORT_TEST_ADB=str(fake_adb),
        )
        env.pop('COPORT_TEST_AUTOSTART_APP', None)

        def client():
            return client_module.Client('coport-m0-wire', env=env)

        with child([str(packaged / 'Contents/MacOS/Coport'), '--tabby-host'], env=env) as reference:
            wait_socket(swift, reference)
            baseline = client()
            try:
                expected = snapshot(baseline)
            finally:
                baseline.close()
        (work / 'swift.json').write_text(json.dumps(expected))

        env['COPORT_TEST_SOCKET'] = str(sdk)
        probe = Path(__file__).with_name('mcp-main.cjs')
        with child([electron, str(probe), str(work)], stdout=subprocess.PIPE, text=True) as server:
            wait_socket(sdk, server)
            observer = client()
            owner = client()
            try:
                compatible(snapshot(observer), expected)
                assert owner.call('write_serial', {'data': 'half'}) == {'bytes_queued': 4}
                start = time.monotonic()
                owner.process.kill()
                with selectors.DefaultSelector() as selector:
                    selector.register(server.stdout, selectors.EVENT_READ)
                    assert selector.select(.2), 'SDK close hook did not protect orphan within 200 ms'
                assert server.stdout.readline().strip() == 'orphan protected'
                elapsed = (time.monotonic() - start) * 1000
                assert elapsed < 200, elapsed
                assert observer.call('write_serial', {'data': 'do not append\r'})['error']['code'] == 'busy'
                print(json.dumps({'tools': sorted(SAMPLES), 'fieldParity': True, 'protectedMs': round(elapsed, 2)}))
            finally:
                owner.close()
                observer.close()


if __name__ == '__main__':
    run(sys.argv[1], Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
