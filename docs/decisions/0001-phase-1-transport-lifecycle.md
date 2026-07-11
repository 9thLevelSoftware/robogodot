# ADR 0001: Phase 1 transport lifecycle

- Status: Accepted
- Date: 2026-07-11

## Context

The source architecture says that the “plugin reconnects,” while the Phase 1 topology makes the Godot editor plugin the localhost WebSocket server and the TypeScript MCP process its client. A listening server cannot reconnect to its client, so heartbeat and recovery ownership must be made explicit.

## Decision

The TypeScript WebSocket client owns the editor connection lifecycle. While connected, it sends JSON-RPC `core.ping` requests as heartbeats. If a response is not received within a configurable heartbeat timeout, it declares liveness lost, closes the connection, and rejects every pending call with the stable `not_connected` error.

After an initial connection failure, socket close, or missed heartbeat, the client reconnects with delays of exactly `1000, 2000, 4000, 8000, 16000, 32000, 60000` milliseconds. Further attempts remain capped at `60000` milliseconds. A successful connection resets the sequence.

This resolves the statement “plugin reconnects” in favor of the actual topology: the plugin is the WebSocket server, while the TypeScript process is the WebSocket client and therefore owns reconnect behavior.

## Consequences

There is one heartbeat mechanism and one reconnect owner. `core.ping` exercises the complete JSON-RPC path through the plugin rather than only the WebSocket framing layer. Callers receive a deterministic `not_connected` outcome whenever editor liveness is lost, and the plugin remains a thin localhost listener without outbound connection state.
