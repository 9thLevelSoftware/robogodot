extends Node

const SceneBridge = preload("scene_bridge.gd")
const InputBridge = preload("input_bridge.gd")
const ScreenshotBridge = preload("screenshot_bridge.gd")
const MAX_JSON := 128 * 1024
var config: Dictionary
var scene: Node
var _last_id := 0
var _scene_bridge := SceneBridge.new()
var _input_bridge: Node
var _screenshot_bridge := ScreenshotBridge.new()
var _server := TCPServer.new()
var _peer: StreamPeerTCP
var _socket_authenticated := false
var _socket_expected := -1
var _socket_body := PackedByteArray()
var _transport := ""

func setup(value: Dictionary, runtime_scene: Node) -> void:
	config = value.duplicate(true); scene = runtime_scene
	_input_bridge = InputBridge.new(); add_child(_input_bridge)
	var error := _server.listen(config.preferredPort, "127.0.0.1")
	if error != OK: push_warning("Runtime socket unavailable; file bridge remains available.")

func _process(_delta: float) -> void:
	if config.is_empty(): return
	if _transport != "file": _poll_socket()
	if _transport == "socket": return
	var directory := DirAccess.open(config.sessionRoot)
	if directory == null: return
	var names := directory.get_files(); names.sort()
	for name in names:
		if name.begins_with("req-") and name.ends_with(".json"):
			_process_file(name); return # exactly one sequential main-thread request

func _poll_socket() -> void:
	if _peer == null and _server.is_connection_available():
		_peer = _server.take_connection(); _peer.set_no_delay(true); _peer.big_endian = true
	if _peer == null: return
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED: _drop_peer(); return
	if _socket_expected < 0 and _peer.get_available_bytes() >= 4:
		_socket_expected = _peer.get_u32()
		if _socket_expected <= 0 or _socket_expected > MAX_JSON: _drop_peer(); return
	if _socket_expected >= 0 and _peer.get_available_bytes() > 0:
		var needed := _socket_expected - _socket_body.size()
		var chunk := _peer.get_data(mini(needed, _peer.get_available_bytes()))
		if chunk[0] != OK: _drop_peer(); return
		_socket_body.append_array(chunk[1])
	if _socket_expected >= 0 and _socket_body.size() == _socket_expected:
		var parsed: Variant = JSON.parse_string(_socket_body.get_string_from_utf8())
		_socket_expected = -1; _socket_body.clear()
		_process_socket_message(parsed)

func _process_socket_message(parsed: Variant) -> void:
	if not parsed is Dictionary: _drop_peer(); return
	if not _socket_authenticated:
		var nonce: Variant = parsed.get("clientNonce"); var supplied: Variant = parsed.get("clientProof")
		if parsed.get("type") != "hello" or parsed.get("version") != config.protocolVersion or parsed.get("sessionId") != config.sessionId or not nonce is String or not _valid_nonce(nonce) or not supplied is String or not _fixed_equal(supplied, _proof("robogodot-client-v1", [nonce])): _drop_peer(); return
		_socket_authenticated = true
		_transport = "socket"
		var server_nonce := Crypto.new().generate_random_bytes(32).hex_encode()
		_send_socket({"type":"hello_ack", "version":config.protocolVersion, "sessionId":config.sessionId, "clientNonce":nonce, "serverNonce":server_nonce, "serverProof":_proof("robogodot-server-v1", [nonce, server_nonce])})
		return
	if not _authenticated(parsed): return
	var id: int = int(parsed.id)
	if id <= _last_id: return
	_last_id = id
	var response := {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "result":_dispatch(parsed.method, parsed.get("params", {}))}
	if JSON.stringify(response).to_utf8_buffer().size() > MAX_JSON: response = {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "error":"response exceeds bound"}
	_send_socket(response)

func _send_socket(value: Dictionary) -> void:
	var bytes := JSON.stringify(value).to_utf8_buffer()
	if _peer == null or bytes.size() > MAX_JSON: return
	_peer.put_u32(bytes.size()); _peer.put_data(bytes)

func _drop_peer() -> void:
	if _peer != null: _peer.disconnect_from_host()
	_peer = null; _socket_authenticated = false; _socket_expected = -1; _socket_body.clear()

func _process_file(name: String) -> void:
	if _transport == "socket": return
	var path: String = config.sessionRoot.path_join(name)
	var directory := DirAccess.open(config.sessionRoot)
	if directory == null or directory.is_link(name): return
	if FileAccess.get_size(path) <= 0 or FileAccess.get_size(path) > MAX_JSON: return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)); DirAccess.remove_absolute(path)
	if not parsed is Dictionary or not _authenticated(parsed): return
	if _transport.is_empty(): _transport = "file"; _server.stop(); _drop_peer()
	var id: int = int(parsed.id)
	if id <= _last_id: return
	_last_id = id
	var result := _dispatch(parsed.method, parsed.get("params", {}))
	var response := {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "result":result}
	var text := JSON.stringify(response)
	if text.to_utf8_buffer().size() > MAX_JSON: response = {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "error":"response exceeds bound"}; text = JSON.stringify(response)
	var temp: String = config.sessionRoot.path_join(".resp-%d-%s.tmp" % [id, Crypto.new().generate_random_bytes(16).hex_encode()]); var final: String = config.sessionRoot.path_join("resp-%d.json" % id)
	var file := FileAccess.open(temp, FileAccess.WRITE)
	if file == null: return
	file.store_string(text); file.flush(); var write_error := file.get_error(); file.close()
	if write_error != OK or FileAccess.get_size(temp) != text.to_utf8_buffer().size() or FileAccess.file_exists(final) or DirAccess.rename_absolute(temp, final) != OK: DirAccess.remove_absolute(temp)

func _authenticated(request: Dictionary) -> bool:
	var id: Variant = request.get("id")
	var valid_id: bool = (id is int or id is float) and is_finite(float(id)) and float(id) == floor(float(id)) and id > 0 and id <= 9007199254740991.0
	return request.get("type") == "request" and request.get("version") == config.protocolVersion and request.get("sessionId") == config.sessionId and request.get("token") == config.token and valid_id and request.get("method") is String and request.method in ["runtime.scene_tree", "runtime.get_node", "runtime.input", "runtime.screenshot"] and request.get("params", {}) is Dictionary

func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"runtime.scene_tree": return _scene_bridge.scene_tree(scene, params)
		"runtime.get_node": return _scene_bridge.get_node(scene, params)
		"runtime.input": return _input_bridge.perform(params)
		"runtime.screenshot": return _screenshot_bridge.capture(get_viewport(), config.sessionRoot.path_join("shots"), params)
	return {"error":"method not found"}

func _proof(label: String, nonces: Array) -> String:
	var parts: Array = [label, config.sessionId, str(config.protocolVersion)]; parts.append_array(nonces)
	var context := HMACContext.new(); context.start(HashingContext.HASH_SHA256, config.token.to_utf8_buffer()); context.update(String.chr(0).join(parts).to_utf8_buffer())
	return context.finish().hex_encode()

func _valid_nonce(value: String) -> bool:
	if value.length() != 64: return false
	for character in value:
		if character not in "0123456789abcdef": return false
	return true

func _fixed_equal(left: String, right: String) -> bool:
	if left.length() != right.length(): return false
	var different := 0
	for index in range(left.length()): different |= left.unicode_at(index) ^ right.unicode_at(index)
	return different == 0

func cleanup() -> void:
	if config.is_empty(): return
	if _input_bridge != null: _input_bridge.release_all()
	_drop_peer(); _server.stop()
	for name in DirAccess.get_files_at(config.sessionRoot):
		if name.begins_with("req-") or name.begins_with("resp-") or name.begins_with(".req-") or name.begins_with(".resp-"): DirAccess.remove_absolute(config.sessionRoot.path_join(name))
