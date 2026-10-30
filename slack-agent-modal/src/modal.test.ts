import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, type ModalClient } from "modal";
import { createChannel, createModal, proxyFor, type ModalOptions } from "./modal.js";
import { collect } from "./test-helpers/fakes.js";

/** A Modal exec: scripted output streams and exit code; records what reached its stdin. */
class FakeProcess {
  stdinText = "";
  stdinClosed = false;
  stdin = {
    writeText: async (text: string) => {
      if (this.stdinClosed) throw new Error("stdin already closed");
      this.stdinText += text;
    },
    close: async () => {
      this.stdinClosed = true;
    },
  };
  constructor(
    public stdout: AsyncIterable<string>,
    public stderr: AsyncIterable<string>,
    private code: number,
  ) {}
  async wait() {
    return this.code;
  }
}

class FakeSandbox {
  execs: { argv: string[]; params: unknown; process: FakeProcess }[] = [];
  terminated = false;
  failTerminate?: Error;
  sidecars: { name: string; image: unknown; params: Record<string, unknown>; execs: string[][] }[] = [];
  constructor(
    public sandboxId: string,
    private client: FakeModal,
  ) {}
  experimentalSidecars = {
    create: async (name: string, image: unknown, params: Record<string, unknown>) => {
      const sidecar = { name, image, params, execs: [] as string[][] };
      this.sidecars.push(sidecar);
      return {
        exec: async (argv: string[]) => {
          sidecar.execs.push(argv);
          const { output, code } = this.client.sidecarWait.shift() ?? { output: "", code: 0 };
          return { stdout: { readText: async () => output }, wait: async () => code };
        },
      };
    },
  };
  async exec(argv: string[], params: unknown) {
    const process = this.client.nextProcess();
    this.execs.push({ argv, params, process });
    return process;
  }
  async terminate(_params?: { wait: true }) {
    if (this.failTerminate) throw this.failTerminate;
    this.terminated = true;
  }
  async poll() {
    return this.terminated ? 137 : null;
  }
}

/** Just the parts of ModalClient that modal.ts uses. */
class FakeModal {
  sandboxList: FakeSandbox[] = [];
  creates: { app: unknown; image: unknown; params: Record<string, unknown> }[] = [];
  builds = 0;
  listCalls: unknown[] = [];
  failCreate?: Error;
  /** What each exec returns, in order; defaults to a silent process exiting 0. */
  processes: FakeProcess[] = [];
  /** What each sidecar readiness check returns, in order; defaults to ready. */
  sidecarWait: { output: string; code: number }[] = [];
  volumeNames: string[] = [];

  nextProcess() {
    return this.processes.shift() ?? new FakeProcess(lines([]), lines([]), 0);
  }

  apps = {
    fromName: async (name: string) => ({ appId: `ap-${name}`, name }),
  };

  private image = {
    imageId: "",
    dockerfileCommands: () => this.image,
    build: async () => {
      this.builds++;
      return { imageId: "im-built" };
    },
  };

  volumes = {
    fromName: async (name: string) => {
      this.volumeNames.push(name);
      return { name, withMountOptions: (options: unknown) => ({ name, options }) };
    },
  };

  images = {
    fromRegistry: () => this.image,
    fromId: async (id: string) => ({ ...this.image, build: async () => ({ imageId: id }) }),
    fromName: async () => this.image,
  };

  sandboxes = {
    create: async (app: unknown, image: unknown, params: Record<string, unknown>) => {
      if (this.failCreate) throw this.failCreate;
      this.creates.push({ app, image, params });
      const sandbox = new FakeSandbox(`sb-${this.sandboxList.length + 1}`, this);
      this.sandboxList.push(sandbox);
      return sandbox;
    },
    fromId: async (id: string) => {
      const sandbox = this.sandboxList.find((s) => s.sandboxId === id);
      if (!sandbox) throw new NotFoundError(`Sandbox ${id} not found`);
      return sandbox;
    },
    list: async function* (this: FakeModal, params: unknown) {
      this.listCalls.push(params);
      yield* this.sandboxList.filter((s) => !s.terminated);
    }.bind(this),
  };
}

async function* lines(chunks: string[]) {
  yield* chunks;
}

const network = { outboundCidrAllowlist: ["10.0.0.3/32"] };
const sidecarNetwork = proxyFor({ volume: "agent-proxy-state" });
const tags = { app: "apollo", role: "bot", instance: "i-1" };

function setup(overrides: Partial<ModalOptions> = {}) {
  const fake = new FakeModal();
  const modal = createModal({
    appName: "apollo",
    role: "bot",
    instance: "i-1",
    runTimeoutMs: 600_000,
    cpu: 2,
    memoryMiB: 2048,
    network,
    client: fake as unknown as ModalClient,
    ...overrides,
  });
  return { fake, modal };
}

const live = () => new AbortController().signal;

test("create: tags, egress and limits on every sandbox, living the run timeout plus the margin; the ID is reported; the image is built once", async () => {
  const { fake, modal } = setup();
  const accepted: string[] = [];
  const first = await modal.create("builtin", live(), (id) => accepted.push(id));
  const second = await modal.create("builtin", live(), (id) => accepted.push(id));
  assert.deepEqual([first.id, second.id], ["sb-1", "sb-2"]);
  assert.deepEqual(accepted, ["sb-1", "sb-2"]);
  assert.equal(fake.builds, 1);
  assert.deepEqual(fake.creates[0].params, {
    timeoutMs: 900_000,
    idleTimeoutMs: 300_000,
    cpu: 2,
    memoryMiB: 2048,
    tags,
    outboundCidrAllowlist: ["10.0.0.3/32"],
  });
});

test("create: an image ID is used as is", async () => {
  const { fake, modal } = setup();
  assert.equal(await modal.prepare("im-prebuilt"), "im-prebuilt");
  assert.equal(fake.builds, 0);
});

test("create: refuses to start once aborted, and wraps Modal's errors", async () => {
  const { fake, modal } = setup();
  const controller = new AbortController();
  controller.abort(new Error("run timed out"));
  await assert.rejects(modal.create("builtin", controller.signal, () => {}), /run timed out/);
  assert.equal(fake.creates.length, 0);

  fake.failCreate = new Error("quota exceeded");
  await assert.rejects(modal.create("builtin", live(), () => {}), /Modal create failed: quota exceeded/);
});

test("exec: runs as the sandbox user, writes stdin then EOF, and streams output then the exit code", async () => {
  const { fake, modal } = setup();
  const { id } = await modal.create("builtin", live(), () => {});
  fake.processes.push(new FakeProcess(lines(["line 1\n", "line 2\n"]), lines(["warning\n"]), 3));

  const events = await collect(modal.exec(id, { command: "echo hi", stdin: "agv_token\nthe prompt", signal: live() }));

  const { argv, params, process } = fake.sandboxList[0].execs[0];
  assert.deepEqual(argv, ["runuser", "-u", "user", "--", "sh", "-c", "echo hi"]);
  assert.deepEqual(params, { mode: "text", stdout: "pipe", stderr: "pipe" });
  assert.equal(process.stdinText, "agv_token\nthe prompt");
  assert.ok(process.stdinClosed);
  assert.deepEqual(
    events.filter((e) => e.type === "stdout"),
    [
      { type: "stdout", data: "line 1\n" },
      { type: "stdout", data: "line 2\n" },
    ],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "stderr"),
    [{ type: "stderr", data: "warning\n" }],
  );
  assert.deepEqual(events.at(-1), { type: "exit", code: 3 });
});

test("exec: aborting while output is pending rejects with the reason", async () => {
  const { fake, modal } = setup();
  const { id } = await modal.create("builtin", live(), () => {});
  async function* stalls() {
    yield "started\n";
    await new Promise(() => {});
  }
  fake.processes.push(new FakeProcess(stalls(), lines([]), 0));
  const controller = new AbortController();
  const seen: string[] = [];

  await assert.rejects(
    (async () => {
      for await (const event of modal.exec(id, { command: "x", stdin: "", signal: controller.signal })) {
        if (event.type === "stdout") seen.push(event.data);
        controller.abort(new Error("run aborted: shutting down"));
      }
    })(),
    /run aborted: shutting down/,
  );
  assert.deepEqual(seen, ["started\n"]);
});

test("exec: a broken output stream fails the run", async () => {
  const { fake, modal } = setup();
  const { id } = await modal.create("builtin", live(), () => {});
  async function* breaks(): AsyncGenerator<string> {
    yield "partial\n";
    throw new Error("connection reset");
  }
  fake.processes.push(new FakeProcess(breaks(), lines([]), 0));
  await assert.rejects(collect(modal.exec(id, { command: "x", stdin: "", signal: live() })), /Modal stream failed: connection reset/);
});

test("delete: terminates; an unknown sandbox counts as already gone; other failures are reported", async () => {
  const { fake, modal } = setup();
  const { id } = await modal.create("builtin", live(), () => {});
  await modal.delete(id);
  assert.ok(fake.sandboxList[0].terminated);
  await modal.delete("sb-never");

  const { id: second } = await modal.create("builtin", live(), () => {});
  fake.sandboxList[1].failTerminate = new Error("unavailable");
  await assert.rejects(modal.delete(second), /Modal terminate failed: unavailable/);
});

test("exists: true while running, false once finished or unknown", async () => {
  const { modal } = setup();
  const { id } = await modal.create("builtin", live(), () => {});
  assert.equal(await modal.exists(id), true);
  await modal.delete(id);
  assert.equal(await modal.exists(id), false);
  assert.equal(await modal.exists("sb-never"), false);
});

test("sweep: terminates every running sandbox in the app with this client's role and instance", async () => {
  const { fake, modal } = setup();
  await modal.create("builtin", live(), () => {});
  await modal.create("builtin", live(), () => {});
  await modal.delete("sb-1");

  assert.deepEqual(await modal.sweep(), ["sb-2"]);
  assert.deepEqual(fake.listCalls, [{ appId: "ap-apollo", tags }]);
  assert.ok(fake.sandboxList.every((s) => s.terminated));
});

test("create with a proxy sidecar: starts Agent Proxy in the sandbox's image from a read-only copy of the Volume, and waits for it", async () => {
  const { fake, modal } = setup({ network: sidecarNetwork });
  assert.equal(await modal.prepare("builtin"), "im-built");
  assert.equal(fake.builds, 1, "no separate sidecar image");
  assert.deepEqual(fake.volumeNames, ["agent-proxy-state"]);

  const accepted: string[] = [];
  await modal.create("builtin", live(), (id) => accepted.push(id));
  assert.deepEqual(accepted, ["sb-1"]);
  assert.deepEqual(fake.creates[0].params.outboundCidrAllowlist, []);
  const [sidecar] = fake.sandboxList[0].sidecars;
  assert.equal(sidecar.name, "agent-proxy");
  assert.equal(sidecar.image, fake.creates[0].image, "the sandbox's own image");
  assert.deepEqual(sidecar.params.volumes, { "/data": { name: "agent-proxy-state", options: { readOnly: true } } });
  assert.match((sidecar.params.command as string[]).join(" "), /cp -a \/data\/\. \/tmp\/proxy\/ .*agent-vault proxy --data-dir \/tmp\/proxy --port 17323/);
  assert.match(sidecar.execs[0].join(" "), /127\.0\.0\.1:17323\/_agent-vault\/ca/);
  assert.deepEqual(fake.volumeNames, ["agent-proxy-state"], "looked up once");
});

test("create with a proxy sidecar: a proxy that never serves fails the create, after the ID is reported", async () => {
  const { fake, modal } = setup({ network: sidecarNetwork });
  fake.sidecarWait.push({ output: "ERR enrollment not found\n", code: 1 });
  const accepted: string[] = [];
  await assert.rejects(
    modal.create("builtin", live(), (id) => accepted.push(id)),
    /Modal proxy sidecar failed: Agent Proxy didn't start in the sidecar: ERR enrollment not found/,
  );
  assert.deepEqual(accepted, ["sb-1"], "so the runner deletes the sandbox");
});

test("proxyFor: a proxy from a Volume is a sidecar the agent dials by name, with no public egress", () => {
  assert.deepEqual(proxyFor({ volume: "agent-proxy-state" }), {
    outboundCidrAllowlist: [],
    proxyAddress: "agent-proxy:17323",
    proxyVolume: "agent-proxy-state",
  });
});

test("proxyFor: a fixed proxy is the only allowed public destination", () => {
  assert.deepEqual(proxyFor({ address: "203.0.113.7:17323" }), {
    outboundCidrAllowlist: ["203.0.113.7/32"],
    proxyAddress: "203.0.113.7:17323",
  });
});

test("proxyFor: refuses a fixed proxy Modal's IPv4-only allowlist can't express", () => {
  for (const address of ["proxy.internal:17323", "[fdaa::3]:17323", "203.0.113.7", "203.0.113.7:17323/x", "203.0.113.7:99999"]) {
    assert.throws(() => proxyFor({ address }), /must be an IPv4 address and port/);
  }
});

test("channel: a push waits while the consumer is `limit` items behind, and resumes as it reads", async () => {
  const channel = createChannel<number>(2);
  let pushed = 0;
  const producer = (async () => {
    for (let i = 0; i < 5; i++) {
      await channel.push(i);
      pushed++;
    }
    channel.close();
  })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pushed, 1, "the second push waits for room");
  assert.deepEqual(await collect(channel.drain(live())), [0, 1, 2, 3, 4]);
  await producer;
});

test("channel: once the consumer stops, queued items are dropped, a waiting push resolves and later pushes are ignored", async () => {
  const channel = createChannel<number>(2);
  const controller = new AbortController();
  const reader = channel.drain(controller.signal);
  const blocked = (async () => {
    await channel.push(1);
    await channel.push(2);
  })();
  assert.equal((await reader.next()).value, 1);
  await reader.return(undefined);
  await blocked;
  assert.equal(channel.ended, true);
  await channel.push(3); // resolves at once
});
