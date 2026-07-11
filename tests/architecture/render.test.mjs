import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ARCHIVE_SHA256,
  CLI_VERSION,
  EXPORT_MAP,
  VIEW_ID_CONTRACTS,
  buildManifest,
  buildNpxInvocation,
  collectAtlasIds,
  diffTraceability,
  extractMermaidBlocks,
  mergeManifestEntries,
  parseTraceabilityIds,
  renderAtlas,
  validateMermaidAnchors,
} from "../../docs/architecture/render.mjs";

const sample = `# Sample

\`\`\`mermaid
flowchart LR
  accTitle: Sample
  accDescr: Accessible sample
  %% atlas-node: ACT-SAMPLE
  ACT_SAMPLE["Sample"]
  %% atlas-node: SYS-TARGET
  SYS_TARGET["Target"]
  %% atlas-flow: FLOW-SAMPLE-001
  ACT_SAMPLE -->|uses| SYS_TARGET
\`\`\`
`;

const TRACEABILITY_HEADER = "| ID | Name | View | Evidence | Source | Phase owner | Consumes | Produces | Consequence |";
const TRACEABILITY_DIVIDER = "|---|---|---|---|---|---|---|---|---|";
const sampleRows = [
  "| `ACT-SAMPLE` | Sample actor | `01-system-context.md` | Explicit | source — heading | Test | input | request | actor consequence |",
  "| `SYS-TARGET` | Sample target | `01-system-context.md` | Explicit | source — heading | Test | request | result | target consequence |",
  "| `FLOW-SAMPLE-001` | Uses | `01-system-context.md` | Explicit | source — heading | Test | request | result | flow consequence |",
];
const SAMPLE_VIEW_ID_CONTRACTS = Object.freeze({
  "01-system-context.md": Object.freeze(["ACT-SAMPLE", "SYS-TARGET", "FLOW-SAMPLE-001"]),
});

const sampleBlock = extractMermaidBlocks(sample)[0];

function buildSampleTraceability({ header = TRACEABILITY_HEADER, rows = sampleRows } = {}) {
  return `# Traceability\n\n${header}\n${TRACEABILITY_DIVIDER}\n${rows.join("\n")}\n`;
}

async function createAtlasFixture(t, { block = sampleBlock, traceability = buildSampleTraceability() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architecture-atlas-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "01-system-context.md"), `# Sample\n\n\`\`\`mermaid\n${block}\n\`\`\`\n`, "utf8");
  await writeFile(path.join(root, "traceability.md"), traceability, "utf8");
  await writeFile(path.join(root, "mermaid-config.json"), "{}\n", "utf8");
  return root;
}

function renderSampleAtlas(options) {
  return renderAtlas({ ...options, viewIdContracts: SAMPLE_VIEW_ID_CONTRACTS });
}

async function createContractFixture(t, { source, markdown, traceability }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architecture-atlas-contract-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, source), markdown, "utf8");
  await writeFile(path.join(root, "traceability.md"), traceability, "utf8");
  return root;
}

test("extracts Mermaid blocks", () => {
  assert.equal(extractMermaidBlocks(sample).length, 1);
});

test("collects semantic IDs from Mermaid source", () => {
  assert.deepEqual(
    [...collectAtlasIds(extractMermaidBlocks(sample))].sort(),
    ["ACT-SAMPLE", "FLOW-SAMPLE-001", "SYS-TARGET"],
  );
});

test("parses traceability IDs and reports both directions", () => {
  const trace = `| ID | Name |\n|---|---|\n| \`ACT-SAMPLE\` | Sample |\n| \`FLOW-STALE\` | Stale |`;
  const ids = parseTraceabilityIds(trace);
  assert.deepEqual(diffTraceability(new Set(["ACT-SAMPLE", "SYS-TARGET"]), ids), {
    missing: ["SYS-TARGET"],
    stale: ["FLOW-STALE"],
  });
});

test("pins the renderer and declares eleven exports", () => {
  assert.equal(CLI_VERSION, "11.16.0");
  assert.equal(ARCHIVE_SHA256, "0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229");
  assert.equal(Object.values(EXPORT_MAP).flat().length, 11);
});

test("declares the exact phase-dependency view ID contract", () => {
  assert.deepEqual(VIEW_ID_CONTRACTS["03-phase-dependencies.md"], [
    "PHASE-00-RESEARCH",
    "PHASE-00-MASTER",
    "PHASE-01",
    "PHASE-02",
    "PHASE-03",
    "PHASE-04",
    "PHASE-05",
    "PHASE-06",
    "PHASE-07",
    "PHASE-08",
    "FLOW-PH-001",
    "FLOW-PH-002",
    "FLOW-PH-003",
    "FLOW-PH-004",
    "FLOW-PH-005",
    "FLOW-PH-006",
    "FLOW-PH-007",
    "FLOW-PH-008",
    "FLOW-PH-009",
    "FLOW-PH-010",
    "FLOW-PH-011",
    "FLOW-PH-012",
    "FLOW-PH-013",
    "FLOW-PH-014",
    "FLOW-PH-015",
    "FLOW-PH-016",
    "FLOW-PH-017",
    "FLOW-PH-018",
  ]);
});

test("declares the exact server-component view ID contract", () => {
  assert.deepEqual(VIEW_ID_CONTRACTS["04-server-components.md"], [
    "CMP-MCP-BOOTSTRAP",
    "CMP-REGISTRY",
    "CMP-SCHEMA-CONTRACTS",
    "CMP-TOOL-FAMILIES",
    "CMP-RESOURCE-PROMPT-SURFACES",
    "CMP-SAFETY",
    "CMP-REQUEST-QUEUE",
    "CMP-READ-CACHE",
    "CMP-AUDIT",
    "CMP-HEALTH",
    "CMP-SEMANTIC-SERVICES",
    "CMP-TRANSPORT-ADAPTERS",
    "CMP-WS-SERVER",
    "CMP-COMMAND-ROUTER",
    "CMP-CORE-COMMANDS",
    "CMP-INTROSPECTION-COMMANDS",
    "CMP-EXEC-COMMANDS",
    "CMP-EDIT-COMMANDS",
    "CMP-EDIT-CONTROLLER",
    "CMP-GODOT-COMPAT",
    "CMP-RUNTIME-AUTOLOADS",
    "SYS-EDITOR-APIS",
    "SYS-CLASSDB-DOCS",
    "SYS-UNDO-REDO",
    "FLOW-CMP-001",
    "FLOW-CMP-002",
    "FLOW-CMP-003",
    "FLOW-CMP-004",
    "FLOW-CMP-005",
    "FLOW-CMP-006",
    "FLOW-CMP-007",
    "FLOW-CMP-008",
    "FLOW-CMP-009",
    "FLOW-CMP-010",
    "FLOW-CMP-011",
    "FLOW-CMP-012",
    "FLOW-CMP-013",
    "FLOW-CMP-014",
    "FLOW-CMP-015",
    "FLOW-CMP-016",
    "FLOW-CMP-017",
    "FLOW-CMP-018",
    "FLOW-CMP-019",
    "FLOW-CMP-020",
    "FLOW-CMP-021",
    "FLOW-CMP-022",
    "FLOW-CMP-023",
  ]);
});

test("declares the exact curated-mutation sequence ID contract", () => {
  assert.deepEqual(VIEW_ID_CONTRACTS["05-editor-mutation-sequence.md"], [
    "CNT-MCP-CLIENT",
    "CMP-REGISTRY",
    "CMP-SCHEMA-CONTRACTS",
    "CMP-SEMANTIC-SERVICES",
    "CMP-SAFETY",
    "CMP-REQUEST-QUEUE",
    "CMP-WS-CLIENT",
    "CMP-COMMAND-ROUTER",
    "CMP-EDIT-CONTROLLER",
    "SYS-UNDO-REDO",
    "CMP-READ-CACHE",
    "CMP-AUDIT",
    ...Array.from({ length: 18 }, (_, index) => `FLOW-MUT-${String(index + 1).padStart(3, "0")}`),
  ]);
});

test("declares the exact runtime-debug sequence ID contract", () => {
  assert.deepEqual(VIEW_ID_CONTRACTS["06-runtime-debug-sequence.md"], [
    "CNT-MCP-CLIENT",
    "CMP-RUNTIME-TOOLS",
    "CMP-PROCESS-RUNNER",
    "CNT-RUNNING-GAME",
    "CMP-DAP-CLIENT",
    "CNT-GODOT-DAP",
    "CMP-RUNTIME-DRIVER",
    "CMP-RUNTIME-AUTOLOADS",
    "CNT-RUNTIME-IPC-FILES",
    "CMP-AUDIT",
    ...Array.from({ length: 20 }, (_, index) => `FLOW-RUN-${String(index + 1).padStart(3, "0")}`),
  ]);
});

test("declares the exact centralized-policy pipeline ID contract", () => {
  assert.deepEqual(VIEW_ID_CONTRACTS["07-policy-pipeline.md"], [
    "CNT-MCP-CLIENT",
    "CMP-REGISTRY",
    "CMP-MODE-GATE",
    "CMP-PATH-GUARD",
    "CMP-EXEC-GUARD",
    "CMP-REQUEST-CLASSIFIER",
    "CMP-READ-CACHE",
    "CMP-REQUEST-QUEUE",
    "CMP-HANDLER",
    "CMP-CACHE-INVALIDATOR",
    "CMP-AUDIT",
    "SYS-STRUCTURED-RESULT",
    "SYS-STRUCTURED-ERROR",
    ...Array.from({ length: 20 }, (_, index) => `FLOW-POL-${String(index + 1).padStart(3, "0")}`),
  ]);
});

test("declares the exact connection-lifecycle view ID contract and exports", () => {
  assert.deepEqual(EXPORT_MAP["08-connection-lifecycles.md"], [
    "08a-editor-websocket-lifecycle.svg",
    "08b-lsp-lifecycle.svg",
    "08c-game-process-lifecycle.svg",
    "08d-dap-lifecycle.svg",
  ]);
  assert.deepEqual(VIEW_ID_CONTRACTS["08-connection-lifecycles.md"], [
    "STATE-WS-DISCONNECTED",
    "STATE-WS-CONNECTING",
    "STATE-WS-CONNECTED",
    "STATE-WS-RECONNECTING",
    "STATE-LSP-DISCONNECTED",
    "STATE-LSP-TCP-CONNECTED",
    "STATE-LSP-INITIALIZING",
    "STATE-LSP-READY",
    "STATE-LSP-DOCUMENT-SYNCED",
    "STATE-LSP-RECONNECTING",
    "STATE-LSP-SHUTTING-DOWN",
    "STATE-LSP-EXITED",
    "STATE-PROC-STOPPED",
    "STATE-PROC-STARTING",
    "STATE-PROC-RUNNING",
    "STATE-PROC-STOPPING",
    "STATE-PROC-EXITED",
    "STATE-PROC-CRASHED",
    "STATE-PROC-FORCE-STOPPING",
    "STATE-DAP-DISCONNECTED",
    "STATE-DAP-INITIALIZED",
    "STATE-DAP-LAUNCHED-ATTACHED",
    "STATE-DAP-RUNNING",
    "STATE-DAP-PAUSED",
    "STATE-DAP-TERMINATED",
    ...Array.from({ length: 6 }, (_, index) => `FLOW-WS-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 11 }, (_, index) => `FLOW-LSP-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 10 }, (_, index) => `FLOW-PROC-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 9 }, (_, index) => `FLOW-DAP-${String(index + 1).padStart(3, "0")}`),
  ]);
});

test("builds a shell-free Windows npx invocation with opaque paths", () => {
  const execPath = String.raw`C:\Tools\Node & 100%^!\node.exe`;
  assert.deepEqual(buildNpxInvocation("win32", execPath), {
    executable: execPath,
    argsPrefix: [path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js")],
  });
  assert.deepEqual(buildNpxInvocation("linux"), {
    executable: "npx",
    argsPrefix: [],
  });
});

test("renderAtlas rejects duplicate traceability IDs", async (t) => {
  const root = await createAtlasFixture(t, {
    traceability: buildSampleTraceability({ rows: [...sampleRows, sampleRows[0]] }),
  });
  await assert.rejects(
    renderSampleAtlas({ check: true, only: new Set(["01-system-context"]), root }),
    /Duplicate traceability IDs: ACT-SAMPLE/,
  );
});

test("renderAtlas requires the exact traceability header", async (t) => {
  const root = await createAtlasFixture(t, {
    traceability: buildSampleTraceability({ header: TRACEABILITY_HEADER.replace("Phase owner", "Owner") }),
  });
  await assert.rejects(
    renderSampleAtlas({ check: true, only: new Set(["01-system-context"]), root }),
    /exact traceability header/,
  );
});

test("renderAtlas enforces immediate unique anchors and one edge per flow anchor", async (t) => {
  const cases = [
    {
      name: "node without anchor",
      block: sampleBlock.replace("  %% atlas-node: SYS-TARGET\n", ""),
      error: /missing immediately preceding atlas-node anchor/,
    },
    {
      name: "edge without anchor",
      block: sampleBlock.replace("  %% atlas-flow: FLOW-SAMPLE-001\n", ""),
      error: /missing immediately preceding atlas-flow anchor/,
    },
    {
      name: "blank between anchor and node",
      block: sampleBlock.replace("  %% atlas-node: SYS-TARGET\n", "  %% atlas-node: SYS-TARGET\n\n"),
      error: /must immediately precede/,
    },
    {
      name: "duplicate node anchor",
      block: sampleBlock.replace(
        "  %% atlas-node: ACT-SAMPLE\n",
        "  %% atlas-node: ACT-SAMPLE\n  %% atlas-node: ACT-SAMPLE\n",
      ),
      error: /Duplicate atlas anchor: ACT-SAMPLE/,
    },
    {
      name: "duplicate flow anchor",
      block: sampleBlock.replace(
        "  %% atlas-flow: FLOW-SAMPLE-001\n",
        "  %% atlas-flow: FLOW-SAMPLE-001\n  %% atlas-flow: FLOW-SAMPLE-001\n",
      ),
      error: /Duplicate atlas anchor: FLOW-SAMPLE-001/,
    },
    {
      name: "one anchor expands to multiple edges",
      block: sampleBlock.replace("  ACT_SAMPLE -->|uses| SYS_TARGET", "  ACT_SAMPLE & SYS_TARGET -->|uses| SYS_TARGET"),
      error: /must map to exactly one Mermaid edge/,
    },
    {
      name: "compact fan-in expands to multiple edges",
      block: sampleBlock.replace("  ACT_SAMPLE -->|uses| SYS_TARGET", "  ACT_SAMPLE&SYS_TARGET -->|uses| SYS_TARGET"),
      error: /must map to exactly one Mermaid edge/,
    },
    {
      name: "compact fan-out expands to multiple edges",
      block: sampleBlock.replace("  ACT_SAMPLE -->|uses| SYS_TARGET", "  ACT_SAMPLE -->|uses| SYS_TARGET&ACT_SAMPLE"),
      error: /must map to exactly one Mermaid edge/,
    },
    {
      name: "unanchored extra channel declaration",
      block: sampleBlock.replace(
        "  %% atlas-flow: FLOW-SAMPLE-001",
        '  CH_EXTRA["Extra channel"]\n  %% atlas-flow: FLOW-SAMPLE-001',
      ),
      error: /CH_EXTRA.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "unanchored bare node declaration",
      block: sampleBlock.replace(
        "  %% atlas-flow: FLOW-SAMPLE-001",
        "  BARE_NODE\n  %% atlas-flow: FLOW-SAMPLE-001",
      ),
      error: /BARE_NODE.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "unanchored Mermaid v11 node declaration",
      block: sampleBlock.replace(
        "  %% atlas-flow: FLOW-SAMPLE-001",
        '  V11_NODE@{ shape: rect, label: "V11 node" }\n  %% atlas-flow: FLOW-SAMPLE-001',
      ),
      error: /V11_NODE.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "implicit extra channel endpoint",
      block: sampleBlock.replace("ACT_SAMPLE -->|uses| SYS_TARGET", "ACT_SAMPLE -->|uses| CH_EXTRA"),
      error: /CH_EXTRA.*must have an anchored node declaration/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const root = await createAtlasFixture(t, { block: fixture.block });
      await assert.rejects(
        renderSampleAtlas({ check: true, only: new Set(["01-system-context"]), root }),
        fixture.error,
      );
    });
  }
});

test("sequence diagrams require immediate participant and message anchors while ignoring directives", async (t) => {
  const sequenceBlock = `sequenceDiagram
  accTitle: Anchored sequence sample
  accDescr: Actor and participant exchange one semantic message inside non-semantic directives.
  %% atlas-node: ACT-SAMPLE
  actor CLIENT as ACT-SAMPLE
  %% atlas-node: SYS-TARGET
  participant TARGET as SYS-TARGET
  rect rgb(245, 245, 245)
    note over CLIENT,TARGET: CLIENT->>TARGET in note prose is not a message
    alt target available
      %% atlas-flow: FLOW-SAMPLE-001
      CLIENT->>TARGET: uses
      %% atlas-flow: FLOW-SAMPLE-002
      TARGET-->>CLIENT: result
    else target unavailable
      opt no-op branch
        note over CLIENT,TARGET: No semantic message in this branch
      end
    end
  end`;

  assert.deepEqual(
    [...validateMermaidAnchors(sequenceBlock, "sequence fixture")].sort(),
    ["ACT-SAMPLE", "FLOW-SAMPLE-001", "FLOW-SAMPLE-002", "SYS-TARGET"],
  );

  const cases = [
    {
      name: "actor without anchor",
      block: sequenceBlock.replace("  %% atlas-node: ACT-SAMPLE\n", ""),
      error: /CLIENT.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "participant without anchor",
      block: sequenceBlock.replace("  %% atlas-node: SYS-TARGET\n", ""),
      error: /TARGET.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "message without anchor",
      block: sequenceBlock.replace("      %% atlas-flow: FLOW-SAMPLE-001\n", ""),
      error: /message missing immediately preceding atlas-flow anchor/,
    },
    {
      name: "directive between anchor and message",
      block: sequenceBlock.replace(
        "      %% atlas-flow: FLOW-SAMPLE-001\n",
        "      %% atlas-flow: FLOW-SAMPLE-001\n      note over CLIENT,TARGET: intervening directive\n",
      ),
      error: /atlas-flow FLOW-SAMPLE-001 must immediately precede a sequence message/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      assert.throws(() => validateMermaidAnchors(fixture.block, "sequence fixture"), fixture.error);
    });
  }
});

test("sequence create declarations require immediate node anchors", async (t) => {
  const sequenceBlock = `sequenceDiagram
  accTitle: Sequence create declaration sample
  accDescr: Dynamically created participant and actor declarations retain atlas anchors.
  %% atlas-node: ACT-SAMPLE
  actor CLIENT as ACT-SAMPLE
  %% atlas-node: CMP-CREATED-PARTICIPANT
  create participant CREATED_PARTICIPANT as CMP-CREATED-PARTICIPANT
  %% atlas-node: SYS-CREATED-ACTOR
  create actor CREATED_ACTOR as SYS-CREATED-ACTOR
  %% atlas-flow: FLOW-SAMPLE-001
  CLIENT->>CREATED_PARTICIPANT: create target`;

  assert.deepEqual(
    [...validateMermaidAnchors(sequenceBlock, "sequence create fixture")].sort(),
    ["ACT-SAMPLE", "CMP-CREATED-PARTICIPANT", "FLOW-SAMPLE-001", "SYS-CREATED-ACTOR"],
  );

  const cases = [
    {
      name: "create participant without anchor",
      block: sequenceBlock.replace("  %% atlas-node: CMP-CREATED-PARTICIPANT\n", ""),
      error: /CREATED_PARTICIPANT.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "create actor without anchor",
      block: sequenceBlock.replace("  %% atlas-node: SYS-CREATED-ACTOR\n", ""),
      error: /CREATED_ACTOR.*missing immediately preceding atlas-node anchor/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      assert.throws(() => validateMermaidAnchors(fixture.block, "sequence create fixture"), fixture.error);
    });
  }
});

test("state diagrams require immediate state and transition anchors, including pseudostate and self-loop transitions", async (t) => {
  const stateBlock = `stateDiagram-v2
  accTitle: Anchored state sample
  accDescr: Quoted state aliases have semantic anchors; initial, ordinary, and self-loop transitions have flow anchors.
  %% atlas-node: STATE-SAMPLE-IDLE
  state "Idle" as SAMPLE_IDLE
  %% atlas-node: STATE-SAMPLE-RUNNING
  state "Running" as SAMPLE_RUNNING
  %% atlas-flow: FLOW-SAMPLE-001
  [*] --> SAMPLE_IDLE
  %% atlas-flow: FLOW-SAMPLE-002
  SAMPLE_IDLE --> SAMPLE_RUNNING : start
  %% atlas-flow: FLOW-SAMPLE-003
  SAMPLE_RUNNING --> SAMPLE_RUNNING : tick`;

  assert.deepEqual(
    [...validateMermaidAnchors(stateBlock, "state fixture")].sort(),
    [
      "FLOW-SAMPLE-001",
      "FLOW-SAMPLE-002",
      "FLOW-SAMPLE-003",
      "STATE-SAMPLE-IDLE",
      "STATE-SAMPLE-RUNNING",
    ],
  );

  const cases = [
    {
      name: "quoted state declaration without anchor",
      block: stateBlock.replace("  %% atlas-node: STATE-SAMPLE-RUNNING\n", ""),
      error: /SAMPLE_RUNNING.*missing immediately preceding atlas-node anchor/,
    },
    {
      name: "initial pseudostate transition without anchor",
      block: stateBlock.replace("  %% atlas-flow: FLOW-SAMPLE-001\n", ""),
      error: /transition missing immediately preceding atlas-flow anchor/,
    },
    {
      name: "self-loop transition without anchor",
      block: stateBlock.replace("  %% atlas-flow: FLOW-SAMPLE-003\n", ""),
      error: /transition missing immediately preceding atlas-flow anchor/,
    },
    {
      name: "blank between anchor and state",
      block: stateBlock.replace(
        "  %% atlas-node: STATE-SAMPLE-RUNNING\n",
        "  %% atlas-node: STATE-SAMPLE-RUNNING\n\n",
      ),
      error: /atlas-node STATE-SAMPLE-RUNNING must immediately precede a state declaration/,
    },
    {
      name: "directive between anchor and transition",
      block: stateBlock.replace(
        "  %% atlas-flow: FLOW-SAMPLE-002\n",
        "  %% atlas-flow: FLOW-SAMPLE-002\n  note right of SAMPLE_IDLE: intervening directive\n",
      ),
      error: /atlas-flow FLOW-SAMPLE-002 must immediately precede a state transition/,
    },
    {
      name: "implicit state endpoint",
      block: stateBlock.replace("SAMPLE_IDLE --> SAMPLE_RUNNING : start", "SAMPLE_IDLE --> SAMPLE_EXTRA : start"),
      error: /SAMPLE_EXTRA.*must have an anchored state declaration/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      assert.throws(() => validateMermaidAnchors(fixture.block, "state fixture"), fixture.error);
    });
  }
});

test("renderAtlas passes the Windows launcher to spawn without a shell", async (t) => {
  const root = await createAtlasFixture(t);
  const execPath = String.raw`C:\Tools\Node & 100%^!\node.exe`;
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };

  await renderSampleAtlas({
    only: new Set(["01-system-context"]),
    root,
    platform: "win32",
    execPath,
    spawn,
  });

  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, execPath);
  assert.equal(args[0], path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"));
  assert.deepEqual(options, { encoding: "utf8" });
});

test("renderAtlas propagates spawn EINVAL and cleans temporary files", async (t) => {
  const root = await createAtlasFixture(t);
  const spawnError = Object.assign(new Error("spawnSync npx-cli.js EINVAL"), { code: "EINVAL" });
  const spawn = () => ({ status: null, error: spawnError, stdout: null, stderr: null });

  await assert.rejects(
    renderSampleAtlas({ only: new Set(["01-system-context"]), root, spawn }),
    /renderer launch failed: EINVAL: spawnSync npx-cli\.js EINVAL/,
  );
  await assert.rejects(access(path.join(root, ".render-tmp")), { code: "ENOENT" });
});

test("renderAtlas enforces exact per-view ID contracts", async (t) => {
  const traceability = await readFile(new URL("../../docs/architecture/traceability.md", import.meta.url), "utf8");

  await t.test("rejects an anchored sixth channel with a matching trace row", async (t) => {
    const source = "02-container-channels.md";
    const original = await readFile(new URL(`../../docs/architecture/${source}`, import.meta.url), "utf8");
    const markdown = original.replace(
      "      %% atlas-node: CH-HEADLESS-BATCH-FS",
      '      %% atlas-node: CH-EXTRA\n      CH_EXTRA["CH-EXTRA<br/>Extra channel"]\n      %% atlas-node: CH-HEADLESS-BATCH-FS',
    );
    assert.notEqual(markdown, original, "extra-channel fixture mutation");
    const withExtraTrace = `${traceability.trimEnd()}\n| \`CH-EXTRA\` | Extra channel | \`02-container-channels.md\` | Explicit | test — fixture | Test | input | output | must fail contract |\n`;
    const root = await createContractFixture(t, { source, markdown, traceability: withExtraTrace });

    await assert.rejects(
      renderAtlas({ check: true, only: new Set(["02-container-channels"]), root }),
      /02-container-channels\.md ID contract mismatch: .*"extra":\["CH-EXTRA"\]/,
    );
  });

  await t.test("rejects missing IDs even when matching trace rows are removed", async (t) => {
    const source = "01-system-context.md";
    const original = await readFile(new URL(`../../docs/architecture/${source}`, import.meta.url), "utf8");
    const markdown = original
      .replace(
        '    %% atlas-node: SYS-ASSET-PROVIDER\n    SYS_ASSET_PROVIDER["SYS-ASSET-PROVIDER<br/>Optional asset provider<br/>feature + credential boundary"]\n',
        "",
      )
      .replace(
        '  %% atlas-flow: FLOW-CTX-006\n  SYS_GODOT_CONTROL_MCP -->|"optionally requests generated assets"| SYS_ASSET_PROVIDER\n',
        "",
      );
    assert.notEqual(markdown, original, "missing-ID fixture mutation");
    const withoutTraceRows = traceability
      .split(/\r?\n/)
      .filter((line) => !/^\| `(?:SYS-ASSET-PROVIDER|FLOW-CTX-006)` \|/.test(line))
      .join("\n");
    const root = await createContractFixture(t, { source, markdown, traceability: withoutTraceRows });

    await assert.rejects(
      renderAtlas({ check: true, only: new Set(["01-system-context"]), root }),
      /01-system-context\.md ID contract mismatch: .*"missing":\["FLOW-CTX-006","SYS-ASSET-PROVIDER"\]/,
    );
  });
});

test("builds detached export provenance", () => {
  const manifest = buildManifest(
    [{ output: "01-system-context.svg", source: "01-system-context.md", block: 1 }],
    "2026-07-10T00:00:00.000Z",
  );
  assert.equal(manifest.renderer, "@mermaid-js/mermaid-cli@11.16.0");
  assert.equal(manifest.sourceArchive.sha256, ARCHIVE_SHA256);
  assert.equal(manifest.exports[0].block, 1);
});

test("merges targeted exports without dropping prior manifest entries", () => {
  assert.deepEqual(
    mergeManifestEntries(
      [{ output: "01-system-context.svg", source: "01-system-context.md", block: 1 }],
      [{ output: "02-container-channels.svg", source: "02-container-channels.md", block: 1 }],
    ).map((entry) => entry.output),
    ["01-system-context.svg", "02-container-channels.svg"],
  );
});
