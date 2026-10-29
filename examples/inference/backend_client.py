"""Bounded app-local JSON-lines transport to one persistent numerical worker."""
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading

MAX_LINE = 262144
MAX_STDERR = 1048576


class PersistentBackend:
    def __init__(self, root, fixtures, *, timeout=60):
        self.timeout, self.ordinal, self.closed = timeout, 0, False
        self.responses = queue.Queue()
        self.stderr_path = Path(root).parent / "backend.stderr.log"
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("worker.py")),
            "--root", str(root), "--fixtures", str(fixtures)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        self.stderr_bytes, self.stderr_truncated = 0, False

        def stdout():
            while True:
                line = self.process.stdout.readline(MAX_LINE + 1)
                if not line:
                    self.responses.put(RuntimeError("Numerical backend exited before responding")); return
                if len(line) > MAX_LINE or not line.endswith(b"\n"):
                    self.responses.put(RuntimeError("Numerical backend response exceeded its line limit")); return
                try: self.responses.put(json.loads(line))
                except Exception as error: self.responses.put(error); return

        def stderr():
            with self.stderr_path.open("xb") as log:
                while chunk := self.process.stderr.read(4096):
                    remaining = max(0, MAX_STDERR - self.stderr_bytes)
                    log.write(chunk[:remaining]); log.flush()
                    self.stderr_bytes += min(remaining, len(chunk))
                    if len(chunk) > remaining: self.stderr_truncated = True
                    # Preserve actual backend warnings for the person running it.
                    sys.stderr.write(chunk.decode("utf-8", errors="replace")); sys.stderr.flush()

        self.readers = [threading.Thread(target=stdout, daemon=True), threading.Thread(target=stderr, daemon=True)]
        for reader in self.readers: reader.start()

    def call(self, command, input=None):
        if self.closed: raise RuntimeError("Numerical backend is closed")
        self.ordinal += 1
        request = {"id": self.ordinal, "command": command, "input": input or {}}
        blob = json.dumps(request, separators=(",", ":"), allow_nan=False).encode() + b"\n"
        if len(blob) > MAX_LINE: raise ValueError("Numerical backend request exceeded its line limit")
        self.process.stdin.write(blob); self.process.stdin.flush()
        try: response = self.responses.get(timeout=self.timeout)
        except queue.Empty:
            self.process.kill(); raise TimeoutError("Numerical backend operation timed out") from None
        if isinstance(response, Exception): raise response
        if response.get("id") != self.ordinal: raise RuntimeError("Numerical backend response ID differs")
        if response.get("ok") is not True: raise RuntimeError("Numerical backend failed: " + str(response.get("error")))
        return response["result"]

    def close(self):
        if self.closed: return
        try:
            if self.process.poll() is None:
                self.call("close")
                self.process.wait(timeout=5)
        finally:
            self.closed = True
            if self.process.poll() is None: self.process.kill(); self.process.wait(timeout=5)
            for reader in self.readers: reader.join(timeout=2)
            for pipe in (self.process.stdin, self.process.stdout, self.process.stderr): pipe.close()
