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
var _pending_client_nonce := ""
var _pending_server_nonce := ""

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
	var selected := ""; var selected_id := 9223372036854775807
	for name in directory.get_files():
		var id := _artifact_id(name, "req-", ".json")
		if id > 0 and id < selected_id: selected = name; selected_id = id
	if not selected.is_empty(): _process_file(selected) # exactly one sequential main-thread request

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
		if _pending_client_nonce.is_empty():
			var nonce: Variant = parsed.get("clientNonce"); var supplied: Variant = parsed.get("clientProof")
			if parsed.get("type") != "hello" or parsed.get("version") != config.protocolVersion or parsed.get("sessionId") != config.sessionId or not nonce is String or not _valid_nonce(nonce) or not supplied is String or not _fixed_equal(supplied, _proof("robogodot-client-v1", [nonce])): _drop_peer(); return
			_pending_client_nonce = nonce; _pending_server_nonce = Crypto.new().generate_random_bytes(32).hex_encode()
			_send_socket({"type":"hello_ack", "version":config.protocolVersion, "sessionId":config.sessionId, "clientNonce":nonce, "serverNonce":_pending_server_nonce, "serverProof":_proof("robogodot-server-v1", [nonce, _pending_server_nonce])})
			return
		var confirmation: Variant = parsed.get("confirmation")
		if parsed.get("type") != "hello_confirm" or parsed.get("version") != config.protocolVersion or parsed.get("sessionId") != config.sessionId or parsed.get("clientNonce") != _pending_client_nonce or parsed.get("serverNonce") != _pending_server_nonce or not confirmation is String or not _fixed_equal(confirmation, _proof("robogodot-confirm-v1", [_pending_client_nonce, _pending_server_nonce])): _drop_peer(); return
		if not _send_socket({"type":"hello_ready", "version":config.protocolVersion, "sessionId":config.sessionId, "clientNonce":_pending_client_nonce, "serverNonce":_pending_server_nonce, "readyProof":_proof("robogodot-ready-v1", [_pending_client_nonce, _pending_server_nonce])}): _drop_peer(); return
		# Authentication is ready, but transport ownership is not committed until
		# the first authenticated request arrives. A client that misses hello_ready
		# can therefore disconnect and use file fallback without splitting the lock.
		_socket_authenticated = true
		return
	var validated := _validated_request(parsed)
	if not validated.ok: return
	if _transport.is_empty(): _transport = "socket"; _server.stop()
	var id: int = int(parsed.id)
	if id <= _last_id: return
	_last_id = id
	var response := {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "result":_dispatch(parsed.method, validated.params)}
	if JSON.stringify(response).to_utf8_buffer().size() > MAX_JSON: response = {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "error":"response exceeds bound"}
	_send_socket(response)

func _send_socket(value: Dictionary) -> bool:
	var bytes := JSON.stringify(value).to_utf8_buffer()
	if _peer == null or bytes.size() > MAX_JSON: return false
	_peer.put_u32(bytes.size())
	return _peer.put_data(bytes) == OK

func _drop_peer() -> void:
	if _peer != null: _peer.disconnect_from_host()
	_peer = null; _socket_authenticated = false; _pending_client_nonce = ""; _pending_server_nonce = ""; _socket_expected = -1; _socket_body.clear()

func _process_file(name: String) -> void:
	if _transport == "socket": return
	var filename_id := _artifact_id(name, "req-", ".json")
	if filename_id < 1: return
	var path: String = config.sessionRoot.path_join(name)
	var directory := DirAccess.open(config.sessionRoot)
	if directory == null or directory.is_link(name): return
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null: return
	var length := file.get_length()
	if length <= 0 or length > MAX_JSON: file.close(); return
	var bytes := file.get_buffer(length); var read_error := file.get_error(); var final_length := file.get_length(); file.close()
	if read_error != OK or bytes.size() != length or final_length != length: return
	var parsed: Variant = JSON.parse_string(bytes.get_string_from_utf8())
	if not parsed is Dictionary: return
	var validated := _validated_request(parsed)
	if not validated.ok or int(parsed.id) != filename_id: return
	directory.remove(name)
	if _transport.is_empty(): _transport = "file"; _server.stop(); _drop_peer()
	var id: int = int(parsed.id)
	if id <= _last_id: return
	_last_id = id
	var result := _dispatch(parsed.method, validated.params)
	var response := {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "result":result}
	var text := JSON.stringify(response)
	if text.to_utf8_buffer().size() > MAX_JSON: response = {"type":"response", "version":config.protocolVersion, "sessionId":config.sessionId, "id":id, "error":"response exceeds bound"}; text = JSON.stringify(response)
	var temp: String = config.sessionRoot.path_join(".resp-%d-%s.tmp" % [id, Crypto.new().generate_random_bytes(16).hex_encode()]); var final: String = config.sessionRoot.path_join("resp-%d.json" % id)
	var response_file := FileAccess.open(temp, FileAccess.WRITE)
	if response_file == null: return
	response_file.store_string(text); response_file.flush(); var write_error := response_file.get_error(); response_file.close()
	if write_error != OK or FileAccess.get_size(temp) != text.to_utf8_buffer().size() or FileAccess.file_exists(final) or DirAccess.rename_absolute(temp, final) != OK: DirAccess.remove_absolute(temp)

func _validated_request(request: Dictionary) -> Dictionary:
	var id: Variant = request.get("id")
	var valid_id: bool = (id is int or id is float) and is_finite(float(id)) and float(id) == floor(float(id)) and id > 0 and id <= 9007199254740991.0
	var method: Variant = request.get("method"); var nonce: Variant = request.get("requestNonce"); var params_json: Variant = request.get("paramsJson"); var supplied: Variant = request.get("requestProof")
	if request.get("type") != "request" or request.get("version") != config.protocolVersion or request.get("sessionId") != config.sessionId or not valid_id or not method is String or method not in ["runtime.scene_tree", "runtime.get_node", "runtime.input", "runtime.screenshot"] or not nonce is String or not _valid_nonce(nonce) or not params_json is String or params_json.to_utf8_buffer().size() > MAX_JSON or not supplied is String: return {"ok":false}
	var expected := _proof("robogodot-request-v1", [str(int(id)), method, nonce, params_json])
	if not _fixed_equal(supplied, expected): return {"ok":false}
	var params: Variant = JSON.parse_string(params_json)
	return {"ok":true, "params":params} if params is Dictionary else {"ok":false}

func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"runtime.scene_tree": return _scene_bridge.scene_tree(scene, params)
		"runtime.get_node": return _scene_bridge.get_node(scene, params)
		"runtime.input": return _input_bridge.perform(params)
		"runtime.screenshot": return _screenshot_bridge.capture(get_viewport(), config.sessionRoot.path_join("shots"), params)
	return {"error":"method not found"}

func _proof(label: String, nonces: Array) -> String:
	var parts: Array = [label, config.sessionId, str(int(config.protocolVersion))]; parts.append_array(nonces)
	var context := HMACContext.new(); context.start(HashingContext.HASH_SHA256, config.token.to_utf8_buffer()); context.update("\n".join(parts).to_utf8_buffer())
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
	var directory := DirAccess.open(config.sessionRoot)
	if directory != null:
		directory.include_hidden = true
		for name in directory.get_files():
			if _owned_artifact(name): directory.remove(name)

func _exit_tree() -> void:
	cleanup()

func _artifact_id(name: String, prefix: String, suffix: String) -> int:
	if not name.begins_with(prefix) or not name.ends_with(suffix): return -1
	var digits := name.substr(prefix.length(), name.length() - prefix.length() - suffix.length())
	if digits.is_empty() or digits.length() > 16 or digits.begins_with("0"): return -1
	for character in digits:
		if character not in "0123456789": return -1
	var value := digits.to_int()
	return value if value > 0 and value <= 9007199254740991 else -1

func _owned_artifact(name: String) -> bool:
	if _artifact_id(name, "req-", ".json") > 0 or _artifact_id(name, "resp-", ".json") > 0: return true
	for prefix in [".req-", ".resp-"]:
		if name.begins_with(prefix) and name.ends_with(".tmp"):
			var middle := name.substr(prefix.length(), name.length() - prefix.length() - 4); var split := middle.rfind("-")
			if split < 1: continue
			var nonce := middle.substr(split + 1); var id_name := "req-%s.json" % middle.substr(0, split)
			if nonce.length() == 32 and _valid_nonce_half(nonce) and _artifact_id(id_name, "req-", ".json") > 0: return true
	return false

func _valid_nonce_half(value: String) -> bool:
	for character in value:
		if character not in "0123456789abcdef": return false
	return true
