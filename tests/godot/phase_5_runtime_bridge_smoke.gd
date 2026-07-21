extends SceneTree

const RuntimeBridge = preload("res://addons/godot_control_mcp/runtime/runtime_bridge.gd")
const ScreenshotBridge = preload("res://addons/godot_control_mcp/runtime/screenshot_bridge.gd")
const SESSION := "0123456789abcdef0123456789abcdef"
const TOKEN := "runtime-smoke-token-runtime-smoke-token"
var session_root: String
var bridge: Node
var runtime_root: Node
var failed := false

class GetterProbe extends Node:
	var reads := 0
	var dangerous: int:
		get: reads += 1; return 7

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	Engine.max_fps = 240
	session_root = ProjectSettings.globalize_path("user://.mcp-runtime-smoke-%d" % OS.get_process_id()).simplify_path()
	DirAccess.make_dir_recursive_absolute(session_root)
	runtime_root = Node2D.new(); runtime_root.name = "RuntimeRoot"; root.add_child(runtime_root)
	var getter_probe := GetterProbe.new(); getter_probe.name = "GetterProbe"; runtime_root.add_child(getter_probe)
	var cursor := runtime_root
	for i in range(40): var child := Node.new(); child.name = "N%d" % i; cursor.add_child(child); cursor = child
	InputMap.add_action("runtime_smoke_action")
	bridge = RuntimeBridge.new(); root.add_child(bridge)
	# JSON.parse may represent integral protocol numbers as floats; proof bytes must
	# still match Node's canonical integer representation.
	bridge.setup({"sessionId":SESSION, "token":TOKEN, "protocolVersion":1.0, "preferredPort":49179, "sessionRoot":session_root}, runtime_root)
	_assert(_request_proof(1, "runtime.scene_tree", "0".repeat(64), "{}") == "dbde05a919c24c1edf37408391151532d3a720df9296e0b177b1809ab95a9c40", "Node and Godot request proof parity")
	_write_request(10, "runtime.scene_tree", {})
	_write_request(2, "runtime.scene_tree", {})
	var ordered_two := await _await_response(2)
	var ordered_ten := await _await_response(10)
	_assert(ordered_two.has("result") and ordered_ten.has("result"), "numeric request ordering")
	_write_json("req-99.json", _request_envelope(98, "runtime.scene_tree", {}))
	var tree := await _request(11, "runtime.scene_tree", {"maxDepth":99})
	var tree_nodes: Array = tree.get("result", {}).get("nodes", [])
	_assert(tree_nodes.size() == 34 and tree_nodes.all(func(item): return item.depth <= 32), "tree depth bound")
	var node := await _request(12, "runtime.get_node", {"path":".", "properties":["name"]})
	_assert(node.get("result", {}).get("properties", {}).get("name") == "RuntimeRoot", "allowlisted property")
	var guarded := await _request(13, "runtime.get_node", {"path":"GetterProbe", "properties":["dangerous"]})
	_assert(getter_probe.reads == 0 and guarded.get("result", {}).get("properties", {}).is_empty(), "custom getter not invoked")
	var absolute := await _request(14, "runtime.get_node", {"path":"/root/RuntimeRoot"})
	var parent := await _request(15, "runtime.get_node", {"path":"../RuntimeRoot"})
	_assert(absolute.get("result", {}).get("error") == "invalid path" and parent.get("result", {}).get("error") == "invalid path", "node lookup stays inside launched scene")
	var input := await _request(16, "runtime.input", {"kind":"action", "action":"runtime_smoke_action", "mode":"press_release", "holdMs":200})
	_assert(input.get("result", {}).get("ok") == true and Input.is_action_pressed("runtime_smoke_action"), "action pressed: " + JSON.stringify(input))
	await create_timer(0.25).timeout
	_assert(not Input.is_action_pressed("runtime_smoke_action"), "action released exactly once")
	await process_frame
	var screenshot := await _request(17, "runtime.screenshot", {"name":"smoke.png"})
	var shot: Dictionary = screenshot.get("result", {})
	_assert(shot.get("error") in ["screenshot viewport unavailable", "screenshot readback failed"], "headless screenshot failure is bounded: " + JSON.stringify(screenshot))
	var image := Image.create(8, 6, false, Image.FORMAT_RGBA8); image.fill(Color.RED)
	shot = ScreenshotBridge.new().publish_image(image, session_root.path_join("shots"), "smoke.png")
	_assert(shot.get("format") == "png" and shot.get("width", 0) == 8 and shot.get("height", 0) == 6 and shot.get("bytes", 0) > 8, "screenshot metadata: " + JSON.stringify(shot))
	_assert(String(shot.get("path", "")).begins_with(session_root.path_join("shots")) and FileAccess.file_exists(shot.get("path", "")), "screenshot containment")
	_assert(TOKEN not in JSON.stringify([tree, node, input, screenshot]), "token redaction")
	_assert(not FileAccess.file_exists(session_root.path_join("resp-99.json")), "filename/body mismatch ignored")
	_write_text("req-prefix.json.bak", "foreign"); _write_text("resp-prefix.json.bak", "foreign"); _write_text(".req-1-nothex.tmp", "foreign")
	_write_text("resp-77.json", "owned"); _write_text(".req-77-0123456789abcdef0123456789abcdef.tmp", "owned")
	bridge.cleanup(); bridge.cleanup(); await process_frame
	_assert(FileAccess.file_exists(session_root.path_join("req-prefix.json.bak")) and FileAccess.file_exists(session_root.path_join("resp-prefix.json.bak")) and FileAccess.file_exists(session_root.path_join(".req-1-nothex.tmp")), "prefix-like artifacts preserved")
	_assert(not FileAccess.file_exists(session_root.path_join("req-99.json")), "exact request artifact cleaned")
	_assert(not FileAccess.file_exists(session_root.path_join("resp-77.json")), "exact response artifact cleaned")
	_assert(not FileAccess.file_exists(session_root.path_join(".req-77-0123456789abcdef0123456789abcdef.tmp")), "exact temporary artifact cleaned")
	var held := await _request(18, "runtime.input", {"kind":"action", "action":"runtime_smoke_action", "mode":"press", "holdMs":2000})
	_assert(held.get("result", {}).get("ok") == true and Input.is_action_pressed("runtime_smoke_action"), "held action active before exit")
	root.remove_child(bridge)
	_assert(not Input.is_action_pressed("runtime_smoke_action"), "tree exit synchronously releases held input")
	bridge.free()
	InputMap.erase_action("runtime_smoke_action"); runtime_root.queue_free()
	for foreign in ["req-prefix.json.bak", "resp-prefix.json.bak", ".req-1-nothex.tmp"]: DirAccess.remove_absolute(session_root.path_join(foreign))
	DirAccess.remove_absolute(session_root.path_join("shots").path_join("smoke.png")); DirAccess.remove_absolute(session_root.path_join("shots")); DirAccess.remove_absolute(session_root)
	if failed: quit(1)
	else: print("PASS phase 5 locked runtime bridge"); quit(0)

func _request(id: int, method: String, params: Dictionary) -> Dictionary:
	_write_request(id, method, params)
	return await _await_response(id, method)

func _write_request(id: int, method: String, params: Dictionary) -> void:
	_write_json("req-%d.json" % id, _request_envelope(id, method, params))

func _request_envelope(id: int, method: String, params: Dictionary) -> Dictionary:
	var nonce := Crypto.new().generate_random_bytes(32).hex_encode(); var params_json := JSON.stringify(params)
	return {"type":"request", "version":1, "sessionId":SESSION, "id":id, "method":method, "requestNonce":nonce, "paramsJson":params_json, "requestProof":_request_proof(id, method, nonce, params_json)}

func _request_proof(id: int, method: String, nonce: String, params_json: String) -> String:
	var parts := ["robogodot-request-v1", SESSION, "1", str(id), method, nonce, params_json]
	var context := HMACContext.new(); context.start(HashingContext.HASH_SHA256, TOKEN.to_utf8_buffer()); context.update("\n".join(parts).to_utf8_buffer())
	return context.finish().hex_encode()

func _await_response(id: int, method := "request") -> Dictionary:
	for attempt in range(30):
		await process_frame
		var response := session_root.path_join("resp-%d.json" % id)
		if FileAccess.file_exists(response): var parsed: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(response)); DirAccess.remove_absolute(response); return parsed
	_assert(false, "request deadline " + method); return {"result":{}}

func _assert(value: bool, label: String) -> void:
	if not value: failed = true; push_error("FAIL " + label)

func _write_json(name: String, value: Dictionary) -> void:
	_write_text(name, JSON.stringify(value))

func _write_text(name: String, value: String) -> void:
	var file := FileAccess.open(session_root.path_join(name), FileAccess.WRITE); file.store_string(value); file.close()
