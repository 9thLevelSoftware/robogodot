extends SceneTree

const Router = preload("../../addons/godot_control_mcp/command_router.gd")
const Server = preload("../../addons/godot_control_mcp/ws_server.gd")
const Core = preload("../../addons/godot_control_mcp/commands/core.gd")
const TOKEN := "0123456789abcdef0123456789abcdef"
const PORT := 19201
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _connect() -> WebSocketPeer:
	var peer := WebSocketPeer.new()
	_check(peer.connect_to_url("ws://127.0.0.1:%d" % PORT) == OK, "connection must start")
	for ignored in range(120):
		peer.poll()
		if peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
			break
		await process_frame
	_check(peer.get_ready_state() == WebSocketPeer.STATE_OPEN, "connection must open")
	return peer

func _request(peer: WebSocketPeer, request: Dictionary) -> Dictionary:
	_check(peer.send_text(JSON.stringify(request)) == OK, "request send must succeed")
	for ignored in range(120):
		peer.poll()
		if peer.get_available_packet_count() > 0:
			return JSON.parse_string(peer.get_packet().get_string_from_utf8())
		await process_frame
	return {}

func _wait_closed(peer: WebSocketPeer) -> void:
	for ignored in range(120):
		peer.poll()
		if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			return
		await process_frame

func _run() -> void:
	var router := Router.new()
	router.register_command("core.ping", Core.ping)
	var server = Server.new()
	root.add_child(server)
	_check(server.start(PORT, router, TOKEN) == OK, "authenticated server must listen")

	var preauth := await _connect()
	var denied := await _request(preauth, {"jsonrpc":"2.0", "id":1, "method":"core.ping", "params":{}})
	_check(denied.get("error", {}).get("code") == -32002, "commands before authentication must be rejected; got %s" % denied)
	await _wait_closed(preauth)
	_check(preauth.get_ready_state() == WebSocketPeer.STATE_CLOSED, "pre-auth command peer must close")

	var missing := await _connect()
	var missing_result := await _request(missing, {"jsonrpc":"2.0", "id":2, "method":"auth.authenticate", "params":{}})
	_check(missing_result.get("error", {}).get("code") == -32001, "missing token must be rejected; got %s" % missing_result)
	await _wait_closed(missing)

	var wrong := await _connect()
	var wrong_result := await _request(wrong, {"jsonrpc":"2.0", "id":3, "method":"auth.authenticate", "params":{"token":"wrong-token-wrong-token-wrong-token"}})
	_check(wrong_result.get("error", {}).get("code") == -32001, "wrong token must be rejected; got %s" % wrong_result)
	await _wait_closed(wrong)

	var owner := await _connect()
	var authenticated := await _request(owner, {"jsonrpc":"2.0", "id":4, "method":"auth.authenticate", "params":{"token":TOKEN}})
	_check(authenticated.get("result", {}).get("authenticated") == true, "correct token must authenticate; got %s" % authenticated)
	var ping := await _request(owner, {"jsonrpc":"2.0", "id":5, "method":"core.ping", "params":{}})
	_check(ping.get("result", {}).get("pong") == true, "authenticated owner must dispatch commands; got %s" % ping)

	var second := await _connect()
	var occupied := await _request(second, {"jsonrpc":"2.0", "id":6, "method":"auth.authenticate", "params":{"token":TOKEN}})
	_check(occupied.get("error", {}).get("code") == -32003, "second active client must be rejected; got %s" % occupied)
	await _wait_closed(second)
	_check(owner.get_ready_state() == WebSocketPeer.STATE_OPEN, "second client must not displace owner")

	owner.close()
	server.stop()
	server.queue_free()
	print("PASS authenticated single-client transport")
	quit(0 if failures.is_empty() else 1)
