#!/usr/bin/env python3
"""Exercise archived lines, terminal replies, and raw-output privacy via the shim."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import pty
import re
import select
import stat
import sys
import time
import uuid

from mcp_client import Client
from wire_test import isolated_host, wait_for


def write_all(fd, data):
    while data:
        try:
            data = data[os.write(fd, data):]
        except BlockingIOError:
            assert select.select([], [fd], [], 3)[1], 'device write stalled'


def wire(fd):
    received = []
    while select.select([fd], [], [], .15)[0]:
        received.append(os.read(fd, 65536))
    return b''.join(received)


def main():
    bundle = Path(sys.argv[1]).resolve()
    master, slave = pty.openpty()
    device = os.ttyname(slave)
    assert device.startswith('/dev/ttys')
    os.set_blocking(master, False)
    try:
        with isolated_host(bundle) as (directory, _, _, env):
            client = Client('coport-m2-history', env=env)
            try:
                assert client.call('open_serial', {'path': device})['reused'] is False
                write_all(master, b'\x1b[6n\x1b[c\x1b[>c\x1b[?6n\x1b[?6$p\x1b]4;1;?\x07')
                answers = wire(master)
                assert re.fullmatch(rb'\x1b\[\d+;\d+R\x1b\[\?62;4;9;22c\x1b\[>0;276;0c'
                                    rb'\x1b\[\?\d+;\d+R\x1b\[\?6;2\$y\x1b\]4;1;rgb:[0-9a-f/]+\x1b\\',
                                    answers), answers
                marker = 'COPORT_PRIVATE_' + uuid.uuid4().hex
                for batch in range(0, 20000, 100):
                    write_all(master, ''.join(
                        f'ROW{i:05d} {"x" * 48}\r\n' for i in range(batch, batch + 100)).encode())
                write_all(master, (marker + '\r\n').encode())
                latest = wait_for(lambda: result if (result := client.call('read_terminal'))['lines']
                                  and result['lines'][-1]['text'] == marker else None)
                assert latest['last_line'] == 20000, latest['last_line']
                previous = client.call('read_terminal', {'after_line': -1, 'max_lines': 13})
                assert previous['gap'] and previous['lines'][0]['n'] == latest['first_available_line']
                following = client.call('read_terminal', {'after_line': previous['next_after_line'], 'max_lines': 13})
                assert not following['gap'] and following['lines'][0]['n'] == previous['next_after_line'] + 1
                write_all(master, b'\x1b[2J\x1b[3J\x1b[HAFTER CLEAR\r\n')
                latest = client.call('read_terminal', {'after_line': latest['last_line'], 'wait_ms': 3000})
                assert [line['text'] for line in latest['lines']] == ['AFTER CLEAR'], latest
                cursor = latest['last_line']
                with ThreadPoolExecutor(1) as pool:
                    pending = pool.submit(client.call, 'read_terminal', {'after_line': cursor, 'wait_ms': 3000})
                    time.sleep(.15)
                    assert not pending.done()
                    write_all(master, b'WAKE\r\n')
                    assert pending.result()['lines'] == [{'n': cursor + 1, 'text': 'WAKE'}]
                write_all(master, b'x' * 100000 + b'\r\n')
                long_line = wait_for(lambda: result['lines'][-1]['text']
                                     if (result := client.call('read_terminal', {'max_lines': 1}))['last_line'] > cursor + 1
                                     else None)
                assert len(long_line.encode()) <= 16384 and long_line.startswith('…[truncated] ')
                needle = [marker.encode(codec) for codec in ('utf8', 'utf-16-le', 'utf-16-be')]
                for file in directory.rglob('*'):
                    if stat.S_ISREG(file.lstat().st_mode):
                        raw = file.read_bytes()
                        assert all(token not in raw for token in needle), file.relative_to(directory)
                print(json.dumps({'committedLines': 20001, 'historyGap': True, 'clearPreservedCursor': True,
                                  'longPollWoke': True, 'lineBytes': len(long_line.encode()),
                                  'singleHeadlessResponder': True, 'rawOutputOnDisk': False}))
            finally:
                client.close()
    finally:
        os.close(master)
        os.close(slave)


if __name__ == '__main__':
    main()
