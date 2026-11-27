"""Exercise serial-main.cjs against a private PTY, with no physical device."""
import os
import json
import pathlib
import pty
import select
import subprocess
import sys
import tempfile
import tty


def run(electron, script, before):
    master, slave = pty.openpty()
    tty.setraw(slave)
    slave_path = os.ttyname(slave)
    noise = b'\xff\x00open-noise\x1b[?1000h\x1b[6n'
    try:
        with tempfile.TemporaryDirectory(dir='dist/coport-m0') as temp:
            alias = pathlib.Path(temp, 'alias')
            alias.symlink_to(slave_path)
            if before:
                os.write(master, noise)
            with subprocess.Popen(
                [electron, script, 'preload' if before else 'during', slave_path, str(alias)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            ) as process:
                try:
                    assert process.stdout.readline().strip() == 'opening'
                    if not before:
                        os.write(master, noise)
                    assert process.stdout.readline().strip() == 'open'
                    os.write(master, b'\xff\x00after-open\x1b[?1000h\x1b[6n')
                    process.stdin.write('go\n')
                    process.stdin.flush()
                    assert select.select([master], [], [], 4)[0], 'AI bytes missing'
                    received = bytearray(os.read(master, 4096))
                    output = process.stdout.read().strip()
                    assert process.wait(timeout=2) == 0
                    while select.select([master], [], [], 0)[0]:
                        received.extend(os.read(master, 4096))
                    print(f'PTY preload={before} master received: ' + json.dumps({
                        'receivedHex': received.hex(),
                        'receivedText': ''.join(chr(byte) if 32 <= byte <= 126 else '.' for byte in received),
                    }), flush=True)
                    assert received == b'ai\r', received
                    print(f'PTY preload={before}: {output}', flush=True)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=2)
    finally:
        os.close(master)
        os.close(slave)


if __name__ == '__main__':
    probe = pathlib.Path(__file__).with_name('serial-main.cjs')
    for preload in (False, True):
        run(sys.argv[1], str(probe), preload)
