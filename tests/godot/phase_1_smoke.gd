extends SceneTree

const Router = preload("../../addons/godot_control_mcp/command_router.gd")
const Server = preload("../../addons/godot_control_mcp/ws_server.gd")
const Core = preload("../../addons/godot_control_mcp/commands/core.gd")
const PORT := 19200

var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _request(peer: WebSocketPeer, payload: String) -> Dictionary:
	peer.send_text(payload)
	for ignored in range(120):
		peer.poll()
		if peer.get_available_packet_count() > 0:
			return JSON.parse_string(peer.get_packet().get_string_from_utf8())
		await process_frame
	return {}

func _run() -> void:
	var router = Router.new()
	_check(router.register_command("core.ping", Core.ping), "first registration must succeed")
	_check(not router.register_command("core.ping", Core.ping), "duplicate registration must fail")
	_check(router.register_command("core.get_version", Core.get_version), "version registration must succeed")
	var unknown: Dictionary = router.dispatch({"jsonrpc":"2.0", "id":1, "method":"missing", "params":{}})
	_check(unknown.error.code == -32601, "unknown command must return -32601")
	print("PASS router")

	var server = Server.new()
	root.add_child(server)
	_check(server.start(PORT, router) == OK, "server must listen")
	var client := WebSocketPeer.new()
	_check(client.connect_to_url("ws://127.0.0.1:%d" % PORT) == OK, "client must connect")
	for ignored in range(120):
		client.poll()
		if client.get_ready_state() == WebSocketPeer.STATE_OPEN:
			break
		await process_frame
	_check(client.get_ready_state() == WebSocketPeer.STATE_OPEN, "websocket must open")

	var ping := await _request(client, '{"jsonrpc":"2.0","id":"ping-id","method":"core.ping","params":{}}')
	_check(ping.id == "ping-id" and ping.result.pong == true, "ping must echo id and pong")
	print("PASS ping")
	var version := await _request(client, '{"jsonrpc":"2.0","id":2,"method":"core.get_version","params":{}}')
	_check(version.id == 2 and version.result.plugin == "0.1.0" and version.result.connected == true, "version response must be connected and versioned")
	_check(version.result.has("engine") and version.result.has("projectPath"), "version response must describe engine and project")
	print("PASS version")
	var malformed := await _request(client, "not json")
	_check(malformed.error.code == -32700, "malformed JSON must return parse error")
	print("PASS malformed request")

	server.stop()
	await process_frame
	_check(not server.is_listening(), "server must stop deterministically")
	print("PASS server shutdown")
	server.queue_free()
	quit(0 if failures.is_empty() else 1)
