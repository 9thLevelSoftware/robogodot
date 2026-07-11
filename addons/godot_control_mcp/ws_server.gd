@tool
extends Node

const MIN_TOKEN_BYTES := 32
const MAX_TOKEN_BYTES := 256
const MAX_AUTH_FRAME_BYTES := 1024
const MAX_PENDING_PEERS := 4
const MAX_TOTAL_PEERS := 5
const PREAUTH_TIMEOUT_MSEC := 500
const REJECTION_FLUSH_MSEC := 25
const HARD_CLOSE_TIMEOUT_MSEC := 100

var _tcp_server := TCPServer.new()
var _peers: Array[WebSocketPeer] = []
var _router: Variant
var _token := ""
var _authenticated: Dictionary = {}
var _owner: WebSocketPeer
var _preauth_deadlines: Dictionary = {}
var _rejections: Dictionary = {}

static func is_open_state(state: int) -> bool:
	return state == WebSocketPeer.STATE_OPEN

func start(port: int, router: Variant, token: String) -> Error:
	var token_size := token.to_utf8_buffer().size()
	if token_size < MIN_TOKEN_BYTES or token_size > MAX_TOKEN_BYTES:
		return ERR_INVALID_PARAMETER
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
	_preauth_deadlines.clear()
	_rejections.clear()
	_owner = null

func _exit_tree() -> void:
	stop()

func _process(_delta: float) -> void:
	while _tcp_server.is_connection_available():
		var stream := _tcp_server.take_connection()
		if _peers.size() >= MAX_TOTAL_PEERS or _pending_peer_count() >= MAX_PENDING_PEERS:
			stream.disconnect_from_host()
			continue
		var peer := WebSocketPeer.new()
		var accept_error := peer.accept_stream(stream)
		if accept_error == OK:
			_peers.append(peer)
			_preauth_deadlines[peer] = Time.get_ticks_msec() + PREAUTH_TIMEOUT_MSEC
		else:
			push_warning("Godot Control MCP rejected a WebSocket stream (error %d)." % accept_error)
	for index in range(_peers.size() - 1, -1, -1):
		var peer := _peers[index]
		peer.poll()
		var now := Time.get_ticks_msec()
		if _rejections.has(peer):
			var rejection: Dictionary = _rejections[peer]
			if not rejection.closing and now >= rejection.flush_at and peer.get_current_outbound_buffered_amount() == 0:
				peer.close(1008, rejection.reason)
				rejection.closing = true
			if now >= rejection.hard_close_at:
				peer.close(-1)
				_remove_peer_at(index)
				continue
		if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			_remove_peer_at(index)
			continue
		if not _authenticated.get(peer, false) and not _rejections.has(peer) and now >= _preauth_deadlines.get(peer, now):
			_send_error_and_close(peer, null, -32004, "Authentication timed out")
			continue
		if not is_open_state(peer.get_ready_state()):
			continue
		while peer.get_available_packet_count() > 0:
			var packet := peer.get_packet()
			if not peer.was_string_packet():
				peer.close(1003, "Text frames only")
				break
			if not _authenticated.get(peer, false) and packet.size() > MAX_AUTH_FRAME_BYTES:
				_send_error_and_close(peer, null, -32001, "Authentication failed")
				break
			_handle_text(peer, packet.get_string_from_utf8())
			if _rejections.has(peer):
				break

func _pending_peer_count() -> int:
	var count := 0
	for peer in _peers:
		if not _authenticated.get(peer, false):
			count += 1
	return count

func _remove_peer_at(index: int) -> void:
	var peer := _peers[index]
	if peer == _owner:
		_owner = null
	_authenticated.erase(peer)
	_preauth_deadlines.erase(peer)
	_rejections.erase(peer)
	_peers.remove_at(index)

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
	if not candidate is String or candidate.to_utf8_buffer().size() > MAX_TOKEN_BYTES or not _constant_time_equal(candidate, _token):
		_send_error_and_close(peer, id, -32001, "Authentication failed")
		return
	if is_instance_valid(_owner) and _owner != peer:
		_send_error_and_close(peer, id, -32003, "Control-plane client already connected")
		return
	_owner = peer
	_authenticated[peer] = true
	_preauth_deadlines.erase(peer)
	peer.send_text(JSON.stringify({"jsonrpc":"2.0", "id":id, "result":{"authenticated":true}}))

func _send_error_and_close(peer: WebSocketPeer, id: Variant, code: int, message: String) -> void:
	peer.send_text(JSON.stringify({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":message}}))
	var now := Time.get_ticks_msec()
	_rejections[peer] = {"reason":message, "flush_at":now + REJECTION_FLUSH_MSEC, "hard_close_at":now + HARD_CLOSE_TIMEOUT_MSEC, "closing":false}

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
