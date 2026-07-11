@tool
extends Node

var _tcp_server := TCPServer.new()
var _peers: Array[WebSocketPeer] = []
var _router: Variant
var _token := ""
var _authenticated: Dictionary = {}
var _owner: WebSocketPeer
var _close_after_flush: Dictionary = {}

static func is_open_state(state: int) -> bool:
	return state == WebSocketPeer.STATE_OPEN

func start(port: int, router: Variant, token: String) -> Error:
	_router = router
	_token = token
	return _tcp_server.listen(port, "127.0.0.1")

func is_listening() -> bool:
	return _tcp_server.is_listening()

func peer_count() -> int:
	return _peers.size()

func stop() -> void:
	_tcp_server.stop()
	for peer in _peers:
		peer.close(1001, "Server stopped")
		peer.poll()
	_peers.clear()
	_authenticated.clear()
	_close_after_flush.clear()
	_owner = null

func _exit_tree() -> void:
	stop()

func _process(_delta: float) -> void:
	while _tcp_server.is_connection_available():
		var peer := WebSocketPeer.new()
		var accept_error := peer.accept_stream(_tcp_server.take_connection())
		if accept_error == OK:
			_peers.append(peer)
		else:
			push_warning("Godot Control MCP rejected a WebSocket stream (error %d)." % accept_error)
	for index in range(_peers.size() - 1, -1, -1):
		var peer := _peers[index]
		peer.poll()
		if _close_after_flush.has(peer) and peer.get_current_outbound_buffered_amount() == 0:
			peer.close(1008, _close_after_flush[peer])
			_close_after_flush.erase(peer)
		if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			if peer == _owner:
				_owner = null
			_authenticated.erase(peer)
			_peers.remove_at(index)
			continue
		if not is_open_state(peer.get_ready_state()):
			continue
		while peer.get_available_packet_count() > 0:
			var packet := peer.get_packet()
			if not peer.was_string_packet():
				peer.close(1003, "Text frames only")
				break
			_handle_text(peer, packet.get_string_from_utf8())
			if _close_after_flush.has(peer):
				break

func _handle_text(peer: WebSocketPeer, text: String) -> void:
	if _authenticated.get(peer, false):
		peer.send_text(JSON.stringify(_router.parse_and_dispatch(text)))
		return
	var json := JSON.new()
	var request: Variant = null
	if json.parse(text) == OK:
		request = json.data
	if request is Dictionary and request.get("method") == "auth.authenticate":
		_authenticate(peer, request)
		return
	_send_error_and_close(peer, request.get("id") if request is Dictionary else null, -32002, "Authentication required")

func _authenticate(peer: WebSocketPeer, request: Dictionary) -> void:
	var id: Variant = request.get("id")
	var params: Variant = request.get("params", {})
	var candidate: Variant = params.get("token") if params is Dictionary else null
	if not candidate is String or not _constant_time_equal(candidate, _token):
		_send_error_and_close(peer, id, -32001, "Authentication failed")
		return
	if is_instance_valid(_owner) and _owner != peer:
		_send_error_and_close(peer, id, -32003, "Control-plane client already connected")
		return
	_owner = peer
	_authenticated[peer] = true
	peer.send_text(JSON.stringify({"jsonrpc":"2.0", "id":id, "result":{"authenticated":true}}))

func _send_error_and_close(peer: WebSocketPeer, id: Variant, code: int, message: String) -> void:
	peer.send_text(JSON.stringify({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":message}}))
	_close_after_flush[peer] = message

static func _constant_time_equal(left: String, right: String) -> bool:
	var left_bytes := left.to_utf8_buffer()
	var right_bytes := right.to_utf8_buffer()
	var difference := left_bytes.size() ^ right_bytes.size()
	var count := maxi(left_bytes.size(), right_bytes.size())
	for index in count:
		var left_byte := left_bytes[index] if index < left_bytes.size() else 0
		var right_byte := right_bytes[index] if index < right_bytes.size() else 0
		difference |= left_byte ^ right_byte
	return difference == 0
