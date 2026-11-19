"""Serve the pinned Core HTTP API for the Web review contract test.

The Web contract suite must prove that a browser request, the Web BFF and the
real Core ``/v1/reviews`` endpoint agree, not that they agree with a recorded
fixture. This script starts that endpoint in-process on a loopback port: the
application object comes from the pinned Core checkout's own test helpers, and
the dictionary is the Core's own synthetic fixture, so no game data or device
credential from a real deployment is involved.

Run it from the Web checkout with the pinned backend:

    python tests/helpers/core-review-server.py /path/to/backend

One JSON line goes to standard output once the socket accepts connections:

    {"base_url": "http://127.0.0.1:PORT/", "token": "wtd1...."}

The token is issued by the Core's real device store, so the BFF authenticates
exactly as it does against a deployment. Everything else, including tracebacks,
goes to standard error. The process serves until it is terminated.

``WUWATERM_API_MAX_BODY_BYTES`` is not consulted: the application is built with
the 64 KiB production ceiling explicitly, which is the size this contract needs.
"""

import importlib.util
import json
import shutil
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path

REVIEW_BODY_BYTES = 65_536


def load_conftest(root: Path):
    """Load the pinned Core's ``tests/conftest.py`` by path, not as a package.

    The fixtures are the Core's own: they write a synthetic WutheringData tree
    and build a real term database from it, so this script cannot drift from
    what the Core's tests consider a valid dictionary.
    """
    spec = importlib.util.spec_from_file_location(
        "wuwaterm_core_conftest", root / "tests" / "conftest.py"
    )
    if spec is None or spec.loader is None:  # pragma: no cover - guarded by the caller
        raise RuntimeError(f"Cannot load {root / 'tests' / 'conftest.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unwrap(module, name: str):
    """The plain function behind a pytest fixture.

    ``pytest.fixture`` wraps the function and keeps the original on
    ``__wrapped__``. Calling the fixture object directly is refused by pytest,
    and re-implementing the fixture data in this repository would let the two
    copies disagree.
    """
    value = getattr(module, name, None)
    wrapped = getattr(value, "__wrapped__", None)
    if wrapped is None:
        raise RuntimeError(
            f"{name} is no longer a pytest fixture with __wrapped__; "
            "update tests/helpers/core-review-server.py for the pinned Core"
        )
    return wrapped


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: core-review-server.py <backend-root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not (root / "src" / "wuwaterm_api").is_dir():
        print(f"{root} is not a WuwaTerm Core checkout", file=sys.stderr)
        return 2
    sys.path.insert(0, str(root))

    conftest = load_conftest(root)
    workdir = Path(tempfile.mkdtemp(prefix="wuwaterm-core-review-"))
    data_dir = unwrap(conftest, "sample_data_dir")(workdir)
    db_path = unwrap(conftest, "sample_db")(workdir, data_dir)

    from tests.test_api import build_client_app, issue_device

    app, store = build_client_app(workdir, db_path, max_body_bytes=REVIEW_BODY_BYTES)
    _device, token = issue_device(store, "web review contract")

    import uvicorn

    # Port 0 lets the kernel choose; the actual port is read back from the
    # listening socket, so no window exists between choosing and binding.
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            access_log=False,
            lifespan="on",
        )
    )
    thread = threading.Thread(target=server.run, name="core-review", daemon=True)
    thread.start()
    deadline = time.monotonic() + 60
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            print("the Core API did not start", file=sys.stderr)
            return 1
        time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    print(
        json.dumps({"base_url": f"http://127.0.0.1:{port}/", "token": token}),
        flush=True,
    )

    # Serve until the caller terminates this process, then remove the synthetic
    # dictionary and device store rather than leaving them in the temp directory.
    def stop(*_unused):
        server.should_exit = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        thread.join()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
