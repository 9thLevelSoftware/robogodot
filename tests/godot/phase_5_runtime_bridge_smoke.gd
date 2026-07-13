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
	bridge.setup({"sessionId":SESSION, "token":TOKEN, "protocolVersion":1, "preferredPort":49179, "sessionRoot":session_root}, runtime_root)
	_write_json("req-99.json", {"type":"request", "version":1, "sessionId":SESSION, "token":TOKEN, "id":98, "method":"runtime.scene_tree", "params":{}})
	var tree := await _request(1, "runtime.scene_tree", {"maxDepth":99})
	var tree_nodes: Array = tree.get("result", {}).get("nodes", [])
	_assert(tree_nodes.size() == 34 and tree_nodes.all(func(item): return item.depth <= 32), "tree depth bound")
	var node := await _request(2, "runtime.get_node", {"path":".", "properties":["name"]})
	_assert(node.get("result", {}).get("properties", {}).get("name") == "RuntimeRoot", "allowlisted property")
	var guarded := await _request(3, "runtime.get_node", {"path":"GetterProbe", "properties":["dangerous"]})
	_assert(getter_probe.reads == 0 and guarded.get("result", {}).get("properties", {}).is_empty(), "custom getter not invoked")
	var input := await _request(4, "runtime.input", {"kind":"action", "action":"runtime_smoke_action", "mode":"press_release", "holdMs":20})
	_assert(input.get("result", {}).get("ok") == true and Input.is_action_pressed("runtime_smoke_action"), "action pressed: " + JSON.stringify(input))
	await create_timer(0.05).timeout
	_assert(not Input.is_action_pressed("runtime_smoke_action"), "action released exactly once")
	await process_frame
	var screenshot := await _request(5, "runtime.screenshot", {"name":"smoke.png"})
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
	_assert(not FileAccess.file_exists(session_root.path_join("req-99.json")) and not FileAccess.file_exists(session_root.path_join("resp-77.json")) and not FileAccess.file_exists(session_root.path_join(".req-77-0123456789abcdef0123456789abcdef.tmp")), "exact artifacts cleaned")
	var held := await _request(6, "runtime.input", {"kind":"action", "action":"runtime_smoke_action", "mode":"press", "holdMs":2000})
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
	var request := {"type":"request", "version":1, "sessionId":SESSION, "token":TOKEN, "id":id, "method":method, "params":params}
	_write_json("req-%d.json" % id, request)
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
