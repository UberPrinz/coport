#!/usr/bin/env python3
"""Cold-launch an explicitly isolated packaged Coport using its own stdio shim."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

import mcp_client
from mcp_client import Client
from wire_test import wait_for


def main():
    bundle = Path(sys.argv[1]).resolve()
    executable = bundle/'Contents/MacOS/Coport'
    mcp_client.SHIM = executable.with_name('coport-mcp')
    with tempfile.TemporaryDirectory(prefix='cp-cold-', dir='/tmp') as work:
        directory = Path(work).resolve()
        endpoint = directory/'mcp.sock'
        env = dict(os.environ, COPORT_TEST_SOCKET=str(endpoint), COPORT_TEST_AUTOSTART_APP=str(bundle), TABBY_PLUGINS='')
        for key in ('ELECTRON_RUN_AS_NODE', 'TABBY_DEV'):
            env.pop(key, None)
        client = None

        def started_pid():
            for line in subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True).splitlines():
                pid, command = line.strip().split(None, 1)
                if command.startswith(str(executable) + ' --coport-background '):
                    if '--user-data-dir=' + str(directory) in command.split():
                        return int(pid)
            return None

        try:
            start = time.monotonic()
            assert not endpoint.exists() and not started_pid()
            client = Client('coport-cold-start', options=('--tabby',), env=env)
            elapsed = time.monotonic() - start
            assert elapsed < 5, elapsed
            assert client.call('get_view_state') == {'log': None}
            assert endpoint.is_socket()
            pid = wait_for(started_pid)
            port_file = directory/'DevToolsActivePort'
            port = wait_for(lambda: port_file.exists() and port_file.read_text().splitlines()[0])
            with urlopen(f'http://127.0.0.1:{port}/json/list', timeout=3) as response:
                assert json.load(response) == [], 'Coport opened a renderer during background startup'
            print(json.dumps({'coldStartMs': round(elapsed * 1000, 2), 'pid': pid, 'rendererTargets': 0,
                              'socketCreated': True, 'legacyTabbyFlag': True}))
        finally:
            if client:
                client.close()
            if pid := started_pid():
                os.kill(pid, signal.SIGKILL)
                wait_for(lambda: started_pid() is None)


if __name__ == '__main__':
    main()
