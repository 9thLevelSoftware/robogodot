@tool
extends Node

var _tcp_server := TCPServer.new()
var _peers: Array[WebSocketPeer] = []
var _router: Variant

static func is_open_state(state: int) -> bool:
	return state == WebSocketPeer.STATE_OPEN

func start(port: int, router: Variant) -> Error:
	_router = router
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
		if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			_peers.remove_at(index)
			continue
		if not is_open_state(peer.get_ready_state()):
			continue
		while peer.get_available_packet_count() > 0:
			var packet := peer.get_packet()
			if not peer.was_string_packet():
				peer.close(1003, "Text frames only")
				break
			peer.send_text(JSON.stringify(_router.parse_and_dispatch(packet.get_string_from_utf8())))
