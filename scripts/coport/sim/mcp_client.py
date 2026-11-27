#!/usr/bin/env python3
"""Small stdlib wire client. Talks to the *packaged* relay, never an internal bridge."""
import json
import os
import selectors
import subprocess
import time
from pathlib import Path

SHIM: Path

class Client:
    def __init__(self, name='coport-wire-test', *, options=(), env=None):
        if env is None or not env.get('COPORT_TEST_SOCKET'):
            raise ValueError('MCP sim requires an isolated socket override')
        self.process = subprocess.Popen([str(SHIM), *options], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env)
        self.sequence = 0
        self.buffer = b''
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.request('initialize', {'protocolVersion':'2025-06-18', 'capabilities':{}, 'clientInfo': {'name':name,'version':'1'}})
        self.send({'jsonrpc':'2.0','method':'notifications/initialized'})

    def send(self, value, fragment=False):
        payload = json.dumps(value, ensure_ascii=False).encode()+b'\n'
        if fragment:
            for i in range(0,len(payload),7):
                self.process.stdin.write(payload[i:i+7]); self.process.stdin.flush()
        else:
            self.process.stdin.write(payload); self.process.stdin.flush()

    def request(self, method, params=None, timeout=10, fragment=False):
        self.sequence += 1
        self.send({'jsonrpc':'2.0','id':self.sequence,'method':method,'params':params or {}},fragment)
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                raw,self.buffer = self.buffer.split(b'\n',1)
                if not raw: continue
                response = json.loads(raw)
                if response.get('id') == self.sequence:
                    assert 'error' not in response, response
                    return response['result']
            if self.selector.select(max(0,deadline-time.monotonic())):
                data = os.read(self.process.stdout.fileno(),65536)
                if not data: raise RuntimeError('Relay closed: '+self.process.stderr.read().decode())
                self.buffer += data
        raise TimeoutError(method)

    def call(self, name, arguments=None, **kwargs):
        result = self.request('tools/call',{'name':name,'arguments':arguments if arguments is not None else {}}, **kwargs)
        assert json.loads(result['content'][0]['text']) == result['structuredContent'], result
        assert result['isError'] == ('error' in result['structuredContent']), result
        return result['structuredContent']

    def close(self):
        self.process.stdin.close()
        try: self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate(); self.process.wait(timeout=3)
        self.selector.close()
        self.process.stdout.close(); self.process.stderr.close()
