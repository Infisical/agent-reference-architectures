"""
Enrolls Agent Proxy once and keeps the enrollment on a Modal Volume, for Apollo's sandboxes.

Apollo runs a copy of this proxy as a sidecar in every sandbox (src/modal.ts), started from
the Volume: proxy.json (the proxy's identity with Infisical) and its CA, which sandboxes pin. This
job writes them there. It starts `infisical agent-vault proxy` against the Volume, which enrolls
with the one-time token from the `agent-proxy` secret on the first run and only resumes the
enrollment after that, commits the Volume and exits. Nothing in it stays running.

    modal run proxy/agent_proxy.py       # needs the `agent-proxy` secret with the enrollment token

See docs/deploy.md, "Agent Proxy on Modal".
"""

import socket
import subprocess
import time

import modal

APP_NAME = "agent-proxy"
VOLUME_NAME = "agent-proxy-state"
DATA_DIR = "/data"
PORT = 17323

# The CLI version the sandbox image uses (src/image.ts), installed from the release's .deb and
# checked against the release's checksums.txt.
CLI_VERSION = "0.44.2"
CLI_DEB_SHA256 = "0412e56044666d634e1e9e7ccbadbbdbe74a06ac497d4671d5fbd229bf8fb8d1"
CLI_DEB_URL = f"https://github.com/Infisical/cli/releases/download/v{CLI_VERSION}/infisical_{CLI_VERSION}_linux_amd64.deb"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ca-certificates", "curl")
    .run_commands(
        f"curl -fsSL -o /tmp/infisical.deb {CLI_DEB_URL}",
        f"echo '{CLI_DEB_SHA256}  /tmp/infisical.deb' | sha256sum -c -",
        "apt-get install -y /tmp/infisical.deb && rm /tmp/infisical.deb",
    )
)

# Enrollment, the proxy's access token and its CA private key. Apollo mounts it read-only.
state = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

app = modal.App(APP_NAME, image=image)


@app.function(
    volumes={DATA_DIR: state},
    # INFISICAL_AGENT_VAULT_ENROLLMENT_TOKEN for the first run; remove it once enrolled.
    secrets=[modal.Secret.from_name("agent-proxy")],
    timeout=120,
)
def enroll() -> None:
    proc = subprocess.Popen(
        ["infisical", "agent-vault", "proxy", "--data-dir", DATA_DIR, "--port", str(PORT), "--telemetry=false"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        # The proxy listens only once enrolled, so a connection means the Volume holds an enrollment.
        deadline = time.monotonic() + 60
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f"agent-vault proxy exited with code {proc.returncode}:\n{proc.stdout.read()}")
            try:
                with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError(f"agent-vault proxy isn't listening on port {PORT} after 60 s")
                time.sleep(0.5)
    finally:
        proc.terminate()
        try:
            output, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            # Already enrolled if it got this far; a proxy slow to stop mustn't fail the job.
            proc.kill()
            output, _ = proc.communicate()
    state.commit()
    # The startup line names the proxy and its CA fingerprint, for AGENT_VAULT_CA_FINGERPRINT.
    for line in output.splitlines():
        if "proxy listening" in line:
            print(line)
    print(f"Enrollment saved on the {VOLUME_NAME} Volume")


@app.local_entrypoint()
def main() -> None:
    enroll.remote()
