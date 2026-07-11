# 05 — Curated Editor Mutation Sequence

## Purpose

This behavioral view defines how one Tier A mutation becomes a validated, serialized, undoable Godot editor change. The registry owns the public MCP boundary, semantic services validate Godot-specific arguments, Phase 7 middleware owns policy and serialization, and the editor plugin remains the authoritative executor. The numbered messages are normative and appear in their required order; alternative bands show which owner terminates or records each failure.

## Source baseline

- Archive: `C:\Users\dasbl\Downloads\files.zip`
- SHA-256: `0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229`
- Source headings: `phase-01-foundation-and-transport.md` — “3. Dependencies & isolation contract,” “4. Architecture,” and “7. Implementation notes”; `phase-02-introspection-and-universal-primitive.md` — “3. Dependencies & isolation contract,” “4. Architecture,” and “5. Design decisions (with rationale)”; `phase-03-curated-editor-mutation-tier.md` — “1. Objective & Definition of Done,” “3. Dependencies & isolation contract,” “4. Architecture,” “6. Development plan (ordered),” “7. Implementation notes,” and “9. Risks & mitigations”; `phase-07-hardening-safety-concurrency-observability.md` — “2. Scope,” “4. Architecture,” “5. Design decisions (with rationale),” “6. Development plan (ordered),” and “7. Implementation notes.”

## Normative Tier A sequence

```mermaid
%%{init: {"sequence": {"width": 190, "actorMargin": 50}}}%%
sequenceDiagram
  accTitle: Curated Tier A editor mutation from MCP request to structured result
  accDescr: One MCP mutation passes schema and Godot semantic validation, policy evaluation, a FIFO mutation lane, correlated editor transport, one undo action, cache invalidation, redacted audit, and a structured response. Alternative bands identify validation, policy, transport, and Godot failures; inferred and unresolved source claims are labeled in message text.

  %% atlas-node: CNT-MCP-CLIENT
  participant MCP_CLIENT as CNT-MCP-CLIENT<br/>MCP client
  %% atlas-node: CMP-REGISTRY
  participant REGISTRY as CMP-REGISTRY<br/>registry
  %% atlas-node: CMP-SCHEMA-CONTRACTS
  participant SCHEMAS as CMP-SCHEMA-CONTRACTS<br/>Zod contracts
  %% atlas-node: CMP-SEMANTIC-SERVICES
  participant SEMANTICS as CMP-SEMANTIC-SERVICES<br/>semantic validation
  %% atlas-node: CMP-SAFETY
  participant SAFETY as CMP-SAFETY<br/>mode + annotations
  %% atlas-node: CMP-REQUEST-QUEUE
  participant QUEUE as CMP-REQUEST-QUEUE<br/>FIFO mutation lane
  %% atlas-node: CMP-WS-CLIENT
  participant WS_CLIENT as CMP-WS-CLIENT<br/>WebSocket JSON-RPC client
  %% atlas-node: CMP-COMMAND-ROUTER
  participant ROUTER as CMP-COMMAND-ROUTER<br/>plugin router
  %% atlas-node: CMP-EDIT-CONTROLLER
  participant EDIT as CMP-EDIT-CONTROLLER<br/>EditController
  %% atlas-node: SYS-UNDO-REDO
  participant UNDO_REDO as SYS-UNDO-REDO<br/>EditorUndoRedoManager
  %% atlas-node: CMP-READ-CACHE
  participant CACHE as CMP-READ-CACHE<br/>tagged read cache
  %% atlas-node: CMP-AUDIT
  participant AUDIT as CMP-AUDIT<br/>redacted audit

  rect rgb(241, 247, 255)
    Note over MCP_CLIENT,SAFETY: Validate before any mutation enters the serialized lane
    %% atlas-flow: FLOW-MUT-001
    MCP_CLIENT->>REGISTRY: MCP call enters registry
    %% atlas-flow: FLOW-MUT-002
    REGISTRY->>SCHEMAS: Zod schema validation
    %% atlas-flow: FLOW-MUT-003
    SCHEMAS->>SEMANTICS: path/property/type validation through semantic services
    alt Schema and semantic validation succeeds
      %% atlas-flow: FLOW-MUT-004
      SEMANTICS->>SAFETY: safety mode and annotation evaluation
    else Invalid arguments or stale path
      %% atlas-flow: FLOW-MUT-005
      SEMANTICS-->>MCP_CLIENT: invalid_args
    end
    Note over SEMANTICS,SAFETY: Only the validation-success branch reaches policy evaluation
    alt Safety mode or annotation blocks mutation
      %% atlas-flow: FLOW-MUT-006
      SAFETY-->>MCP_CLIENT: blocked_by_policy
      %% atlas-flow: FLOW-MUT-007
      SAFETY->>AUDIT: [INFERRED] blocked outcome reaches audit (Q-007)
      Note over SAFETY,AUDIT: [INFERRED] Q-007 — every-call audit prose conflicts with the direct blocked branch
    else Safety allows mutation
      %% atlas-flow: FLOW-MUT-008
      SAFETY->>QUEUE: enqueue one FIFO mutation
    end
  end

  rect rgb(244, 252, 246)
    Note over QUEUE,UNDO_REDO: The queued handler owns one correlated editor attempt
    %% atlas-flow: FLOW-MUT-009
    QUEUE->>WS_CLIENT: correlated JSON-RPC call
    alt not_connected — editor or plugin unavailable
      Note over QUEUE,WS_CLIENT: Return not_connected with an enable/open-editor hint, no plugin mutation occurred
    else timeout — correlation deadline expires
      Note over QUEUE,WS_CLIENT: Return timeout, late transport data cannot create a second queue item
    else Editor transport connected
      %% atlas-flow: FLOW-MUT-010
      WS_CLIENT->>ROUTER: route edit command
      alt godot_error — command fails before commit
        Note over ROUTER,EDIT: Return godot_error with actionable context, do not invalidate mutation tags
      else Godot accepts the curated edit
        %% atlas-flow: FLOW-MUT-011
        ROUTER->>EDIT: create one undo action
        %% atlas-flow: FLOW-MUT-012
        EDIT->>UNDO_REDO: register do/undo operations
        %% atlas-flow: FLOW-MUT-013
        EDIT->>UNDO_REDO: commit action
      end
    end
    %% atlas-flow: FLOW-MUT-014
    WS_CLIENT-->>QUEUE: result returns through transport
  end

  rect rgb(255, 249, 235)
    Note over REGISTRY,AUDIT: Post-handler ownership applies to the correlated success or failure outcome
    opt Mutation committed
      %% atlas-flow: FLOW-MUT-015
      QUEUE->>CACHE: invalidate affected cache tags
      Note over QUEUE,CACHE: Cache invalidation targets scene_tree, project_settings, or affected resource tags
    end
    %% atlas-flow: FLOW-MUT-016
    REGISTRY->>AUDIT: append redacted audit outcome
    %% atlas-flow: FLOW-MUT-017
    REGISTRY-->>MCP_CLIENT: return structuredContent
  end

  rect rgb(252, 244, 244)
    Note over EDIT,UNDO_REDO: Separate source-conflict overlay — not a post-response happy-path step
    opt Destructive project-setting mutation requested
      %% atlas-flow: FLOW-MUT-018
      EDIT->>EDIT: [UNRESOLVED] destructive project-setting exception (Q-005)
      Note over EDIT,UNDO_REDO: [UNRESOLVED] Q-005 — Tier A requires exact undo, but the source permits a destructive non-undoable exception
    end
  end
```

## Failure ownership and consequences

| Outcome | Owner | Mutation and cache consequence | Audit and client consequence |
|---|---|---|---|
| `invalid_args` | Zod contracts or semantic validation | Stops before the FIFO lane; no editor call and no cache invalidation. | Returns an actionable argument/path/property/type error. Rejected-call audit coverage remains subject to `Q-007`. |
| `blocked_by_policy` | Safety middleware | Stops before the FIFO lane; no editor call and no cache invalidation. | The blocked outcome reaching audit is **[INFERRED]** from the every-call requirement and tracked by `Q-007`. |
| `not_connected` | WebSocket client | The queued attempt cannot dispatch; no Godot change and no cache invalidation. | Returns an editor/plugin setup hint, then records the bounded outcome. |
| `timeout` | WebSocket client and request queue | The correlated attempt expires without creating another mutation item; cache tags remain unchanged unless a commit was confirmed. | Returns the stable timeout error and audits the bounded outcome. |
| `godot_error` | Plugin router or edit controller | No cache invalidation occurs when the command fails before commit. | Returns actionable Godot context and appends a redacted outcome. |
| committed mutation | Edit controller and `EditorUndoRedoManager` | Exactly one action commits; affected read-cache tags are invalidated. | Registry appends the redacted outcome and returns `structuredContent`. |

## Interpretation constraints

- One policy-approved Tier A write occupies one FIFO mutation item and issues one correlated JSON-RPC call. Retries, if any, are a caller decision and cannot silently duplicate the editor action.
- A successful curated edit creates one named undo action, registers paired do/undo operations, and commits once before cache invalidation.
- The final red band is a documentary exception overlay, not a continuation after the client response. `FLOW-MUT-018` is **[UNRESOLVED]** under `Q-005`: the source simultaneously requires every Tier A mutation to be exactly undoable and permits a destructive project-setting exception.
- Evidence status is carried in message and note text. Sequence arrows retain their ordinary call/response meaning.
