#!/usr/bin/env python3
"""Run four terminal types and both file backends through one isolated Coport window."""
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tty

master, slave = pty.openpty()
try:
    tty.setraw(slave)
    device = os.ttyname(slave)
    assert device.startswith('/dev/ttys')
    script = Path(__file__).with_suffix('.mjs')
    subprocess.run(['node', str(script), sys.argv[1], device], check=True, timeout=180)
    assert select.select([master], [], [], 2)[0], 'AI write did not reach the original private PTY'
    assert os.read(master, 65536) == b'M3-AI-STILL-BOUND\r'
finally:
    os.close(slave)
    os.close(master)
