#!/usr/bin/env python3
"""Sandbox runner: persistent IPython shell speaking a line-delimited JSON
protocol on stdin/stdout.

Server writes one request per line, e.g.:
    {"code": "print(1+1)", "timeoutMs": 30000}

Runner writes one response per line:
    {"stdout": "2\\n", "stderr": "", "images": [], "timedOut": false}

Special requests:
    {"shutdown": true}  -> runner emits {"goodbye": true} then exits cleanly.

The runner enforces the per-cell wall-clock timeout via SIGALRM. C-level
blocking calls (e.g., a long pandas operation) may not honor the signal
immediately; the server enforces a hard kill grace period as a safety net.
"""

import base64
import io
import json
import os
import signal
import sys
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")

from IPython.core.interactiveshell import InteractiveShell
from IPython.utils.capture import capture_output

DEFAULT_TIMEOUT_MS = 30_000


class _CellTimeout(Exception):
    pass


def _on_alarm(signum, frame):
    raise _CellTimeout("cell exceeded timeout")


def _collect_pending_figures():
    """Save any open matplotlib figures as base64 PNG and close them."""
    images = []
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return images
    for fignum in list(plt.get_fignums()):
        try:
            fig = plt.figure(fignum)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
            plt.close(fig)
        except Exception:
            # Don't fail the whole cell because one figure misbehaved.
            continue
    return images


def _format_error(err):
    if err is None:
        return None, None
    msg = "".join(traceback.format_exception_only(type(err), err)).strip()
    return msg, type(err).__name__


def _execute(shell, code, timeout_ms):
    has_alarm = hasattr(signal, "SIGALRM") and hasattr(signal, "setitimer")
    previous_handler = None
    if has_alarm:
        previous_handler = signal.signal(signal.SIGALRM, _on_alarm)

    timed_out = False
    result = None
    cap_stdout = ""
    cap_stderr = ""
    display_outputs = []

    try:
        if has_alarm:
            seconds = max(0.001, timeout_ms / 1000.0)
            signal.setitimer(signal.ITIMER_REAL, seconds)
        try:
            with capture_output() as cap:
                result = shell.run_cell(code, store_history=False)
        except _CellTimeout:
            timed_out = True
        finally:
            if has_alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
            # capture_output exits even on exception, but only after the
            # `with` block fully unwinds. Re-read what was captured.
            try:
                cap_stdout = cap.stdout or ""
                cap_stderr = cap.stderr or ""
                display_outputs = list(cap.outputs or [])
            except Exception:
                pass
    finally:
        if has_alarm and previous_handler is not None:
            signal.signal(signal.SIGALRM, previous_handler)

    images = []
    for out in display_outputs:
        data = getattr(out, "data", None) or {}
        png = data.get("image/png")
        if isinstance(png, str):
            images.append(png)
        elif isinstance(png, (bytes, bytearray)):
            images.append(base64.b64encode(png).decode("ascii"))
    images.extend(_collect_pending_figures())

    payload = {
        "stdout": cap_stdout,
        "stderr": cap_stderr,
        "images": images,
        "timedOut": timed_out,
    }

    if timed_out:
        payload["error"] = f"Execution timed out after {timeout_ms}ms"
        payload["errorType"] = "TimeoutError"
    elif result is not None and not result.success:
        err = result.error_in_exec or result.error_before_exec
        msg, name = _format_error(err)
        if msg:
            payload["error"] = msg
            payload["errorType"] = name

    return payload


def _bootstrap(shell):
    """Pre-import matplotlib in non-interactive mode so user cells never see
    an interactive backend."""
    shell.run_cell(
        "import matplotlib\n"
        "matplotlib.use('Agg', force=True)\n"
        "import matplotlib.pyplot as plt\n"
        "plt.ioff()\n",
        store_history=False,
    )


def main():
    InteractiveShell.clear_instance()
    shell = InteractiveShell.instance()
    _bootstrap(shell)

    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(
                json.dumps(
                    {
                        "stdout": "",
                        "stderr": "",
                        "images": [],
                        "timedOut": False,
                        "error": f"invalid JSON: {exc}",
                        "errorType": "ProtocolError",
                    }
                )
                + "\n"
            )
            sys.stdout.flush()
            continue

        if request.get("shutdown") is True:
            sys.stdout.write(json.dumps({"goodbye": True}) + "\n")
            sys.stdout.flush()
            return

        code = request.get("code", "")
        if not isinstance(code, str):
            code = ""
        timeout_ms = request.get("timeoutMs", DEFAULT_TIMEOUT_MS)
        try:
            timeout_ms = int(timeout_ms)
        except (TypeError, ValueError):
            timeout_ms = DEFAULT_TIMEOUT_MS

        try:
            payload = _execute(shell, code, timeout_ms)
        except Exception as exc:  # defensive — never crash the loop
            payload = {
                "stdout": "",
                "stderr": "",
                "images": [],
                "timedOut": False,
                "error": f"runner internal error: {exc}",
                "errorType": type(exc).__name__,
            }

        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
