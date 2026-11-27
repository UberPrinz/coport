#!/usr/bin/env python3
"""M4 L2: packaged MCP -> App -> serial.io -> PTY -> interactive /bin/sh."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import tempfile
import mcp_client
from mcp_client import Client

ROOT = Path(__file__).resolve().parents[3]
from shell_device import ShellDevice

parser = argparse.ArgumentParser()
parser.add_argument('bundle', type=Path)
parser.add_argument('scenario', nargs='?', choices=['all','exec','busy','timeout','prepare'], default='all')
args = parser.parse_args()
bundle = args.bundle.resolve()
assert bundle.name == 'Coport.app'
mcp_client.SHIM = bundle/'Contents/MacOS/coport-mcp'
state = ROOT/'dist/coport-m2/evidence'
state.mkdir(parents=True, exist_ok=True)
run = tempfile.TemporaryDirectory(prefix='cp-exec-', dir='/tmp')
endpoint = Path(run.name)/'mcp.sock'
env = dict(os.environ, COPORT_TEST_SOCKET=str(endpoint), COPORT_TEST_ADB=str(Path(run.name)/'no-adb'), TABBY_PLUGINS='')
for key in ('COPORT_TEST_AUTOSTART_APP', 'ELECTRON_RUN_AS_NODE', 'TABBY_DEV'):
    env.pop(key, None)
device = ShellDevice()
assert device.path.startswith('/dev/ttys')
log = (state/'serial-exec.log').open('w')
client = None
app = subprocess.Popen([str(bundle/'Contents/MacOS/Coport'), '--coport-background',
                        '--user-data-dir=' + run.name], stdout=log, stderr=log, env=env)
checks = []; command_rows = []
def check(condition, name):
    assert condition, name
    checks.append(name)
def call(name, arguments=None): return client.call(name, arguments, timeout=15)
def wait_prompt():
    deadline = time.monotonic()+5
    while time.monotonic() < deadline:
        current = call('read_terminal').get('current_line', '')
        if current.rstrip().endswith(('#', '$')): time.sleep(.1); return
        time.sleep(.03)
    raise AssertionError('No prompt: '+repr(current))
def busy(reason, operation='exec'):
    before = len(device.captured)
    result = call(operation, {'command':'true'} if operation == 'exec' else {})
    check(result.get('error', {}).get('details', {}).get('reason') == reason, operation+' busy '+reason+': '+repr(result))
    time.sleep(.05); check(len(device.captured) == before, operation+' '+reason+' zero writes')
try:
    for _ in range(100):
        if app.poll() is not None: raise RuntimeError('App exited; see '+str(state/'serial-exec.log'))
        if endpoint.exists(): break
        time.sleep(.05)
    client = Client('coport-serial-exec', env=env)
    opened = call('open_serial', {'path': device.path})
    check(opened.get('reused') is False, 'MCP opened private PTY: ' + repr(opened))
    call('write_serial', {'data':'\r'}); wait_prompt()
    busy('not_prepared')
    check(call('prepare_shell') == {'prepared':True,'already':False}, 'prepare succeeds')
    wait_prompt(); before = len(device.captured)
    check(call('prepare_shell') == {'prepared':True,'already':True}, 'prepare already')
    time.sleep(.05); check(len(device.captured) == before, 'prepare already zero writes')
    if args.scenario in ('all','exec'):
        for command, rc, expected in [("printf \"%s\" \"中文 single 'quote'\"; exit 7",7,"中文 single 'quote'"), ('false',1,''), ('coport_missing_command_123',127,None), ("printf '\\033[31mone\\033[0m\\ntwo'",0,'one\ntwo')]:
            wait_prompt(); result = call('exec', {'command':command})
            check(result.get('channel') == 'serial' and result.get('exit_code') == rc and (expected is None or result.get('output') == expected), 'exec output/exit '+command+': '+repr(result))
        wait_prompt(); result = call('exec', {'command':"head -c 2097152 /dev/zero | tr '\\000' x",'max_output_bytes':1024})
        check(result.get('output_truncated') is True and '2096128 bytes omitted' in result['output'] and result['output'].startswith('x'*512) and result['output'].endswith('x'*512), '2MiB bounded head/tail truncation')
        wait_prompt(); before = len(device.captured); result = call('exec', {'command':'x'*899})
        check(result.get('error',{}).get('code') == 'command_too_long' and len(device.captured) == before, '900 byte escaped limit zero writes')
        wait_prompt(); device.noise = True
        result = call('exec', {'command':"printf start; sleep 0.3; printf end"}); device.noise = False
        check(result.get('exit_code') == 0 and 'coport-kmsg' in result.get('output','') and result['output'].find('start') < result['output'].find('end'), '50ms kernel noise retained: '+repr(result))
    if args.scenario in ('all','exec'):
        # The spec's 100+100 gate remains in force after replacing BusyBox with PTY /bin/sh.
        for noisy in (False, True):
            for index in range(100):
                if not noisy: wait_prompt()
                else: time.sleep(.06)
                if index == 0: device.next_noise = time.monotonic()+.05; device.noise = noisy
                command = "printf 'case %d 中文\\n'; %s exit %d" % (index, 'sleep .15;' if noisy else '', index % 3)
                result = call('exec', {'command':command})
                expected = 'case %d 中文\n'%index
                passed = result.get('exit_code') == index % 3 and (not noisy and result.get('output') == expected or noisy and 'coport-kmsg' in result.get('output',''))
                command_rows.append({'noise':noisy,'number':index+1,'passed':passed,'result':result})
                check(passed, ('noise' if noisy else 'quiet')+' 100-case gate '+str(index+1))
            device.noise = False
    if args.scenario in ('all','busy','prepare'):
        wait_prompt(); call('write_serial', {'data':'cat\r'}); time.sleep(.2); busy('running'); busy('not_at_prompt', 'prepare_shell')
        call('write_serial', {'encoding':'hex','data':'03'}); wait_prompt()
        for mode in (47,1047,1049):
            device.emit(('\x1b[?%dh'%mode).encode()); time.sleep(.1); busy('fullscreen'); busy('fullscreen','prepare_shell')
            device.emit(('\x1b[?%dl'%mode).encode()); time.sleep(.1); busy('running')
            call('write_serial', {'data':'\r'}); wait_prompt()
        call('write_serial', {'data':"'\r"}); time.sleep(.2); busy('not_at_prompt','prepare_shell')
        call('write_serial', {'encoding':'hex','data':'03'}); wait_prompt()
    if args.scenario in ('all','timeout'):
        wait_prompt(); result = call('exec', {'command':'sleep 100','timeout_ms':1000})
        details = result.get('error',{}).get('details',{})
        check(result.get('error',{}).get('code') == 'timeout' and details.get('interrupt') == 'ctrl_c_sent' and details.get('shell_recovered') is True, 'timeout Ctrl+C recovery: '+repr(result))
        wait_prompt(); check(call('exec', {'command':'printf recovered'}).get('output') == 'recovered', 'exec succeeds after timeout')
    report = {'passed':True,'environment':'macOS PTY + /bin/sh (not BusyBox); no real devices','checks':checks,'commands':command_rows}
finally:
    if client: client.close()
    app.terminate()
    try: app.wait(timeout=5)
    except subprocess.TimeoutExpired: app.kill(); app.wait()
    device.close(); log.close()
    report = locals().get('report', {'passed':False,'checks':checks,'commands':command_rows})
    run.cleanup()
    (state/('serial-exec-'+args.scenario+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
