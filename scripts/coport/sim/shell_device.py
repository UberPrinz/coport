"""Two PTYs bridge the serial port to a real, isolated /bin/sh job-control terminal."""
import errno
import fcntl
import os
import pty
import select
import signal
import termios
import threading
import time
import tty

class ShellDevice:
    def __init__(self):
        self.master, self.slave = pty.openpty()
        self.path = os.ttyname(self.slave)
        tty.setraw(self.slave)
        self.shell_master, shell_slave = pty.openpty()
        self.pid = os.fork()
        if self.pid == 0:
            os.close(self.master); os.close(self.slave); os.close(self.shell_master)
            os.setsid(); fcntl.ioctl(shell_slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2): os.dup2(shell_slave, fd)
            if shell_slave > 2: os.close(shell_slave)
            os.execve('/bin/sh', ['sh', '-i'], dict(os.environ, PS1='# ', PS2='> ', TERM='xterm'))
        os.close(shell_slave)
        for fd in (self.master, self.shell_master): os.set_blocking(fd, False)
        self.captured = bytearray(); self.output = bytearray()
        self.stop = threading.Event(); self.noise = False; self.next_noise = time.monotonic()
        self.thread = threading.Thread(target=self.loop, daemon=True); self.thread.start()
    def loop(self):
        pending = {self.master: bytearray(), self.shell_master: bytearray()}
        while not self.stop.is_set():
            readable, writable, _ = select.select(list(pending), [fd for fd in pending if pending[fd]], [], .01)
            for source in readable:
                try: data = os.read(source, 65536)
                except OSError as error:
                    if error.errno in (errno.EIO, errno.EAGAIN): continue
                    return
                if source == self.master:
                    self.captured.extend(data); destination = self.shell_master
                else:
                    self.output.extend(data); destination = self.master
                pending[destination].extend(data)
            for destination in writable:
                try:
                    n = os.write(destination, pending[destination][:65536]); del pending[destination][:n]
                except BlockingIOError: pass
                except OSError: return
            if self.noise and time.monotonic() >= self.next_noise:
                pending[self.master].extend(b'[ 123.456] coport-kmsg\r\n'); self.next_noise = time.monotonic()+.05
    def emit(self, data): os.write(self.master, data)
    def close(self):
        self.stop.set(); self.thread.join(timeout=2)
        # Only this synthetic shell's session and its foreground job are signalled.
        try:
            foreground = os.tcgetpgrp(self.shell_master)
            if foreground != os.getpgrp(): os.killpg(foreground, signal.SIGKILL)
        except ProcessLookupError: pass
        except OSError: pass
        try: os.killpg(self.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        for fd in (self.master, self.slave, self.shell_master): os.close(fd)
        os.waitpid(self.pid, 0)
