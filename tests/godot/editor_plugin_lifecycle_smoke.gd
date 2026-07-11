extends SceneTree

const Plugin = preload("../fixtures/godot_project/addons/godot_control_mcp/plugin.gd")
const PORT := 19201
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _connect() -> WebSocketPeer:
	var client := WebSocketPeer.new()
	_check(client.connect_to_url("ws://127.0.0.1:%d" % PORT) == OK, "lifecycle client connect must start")
	for ignored in range(120):
		client.poll()
		if client.get_ready_state() == WebSocketPeer.STATE_OPEN:
			return client
		await process_frame
	return client

func _run() -> void:
	var cfg := ConfigFile.new()
	_check(cfg.load("res://addons/godot_control_mcp/plugin.cfg") == OK, "real plugin.cfg must load")
	_check(Plugin.port_from_environment() == PORT, "valid GODOT_MCP_PORT must be used")
	for value in ["", "abc", "-1", "0", "65536"]:
		_check(Plugin.parse_port(value) == 9200, "invalid port '%s' must fall back" % value)
	var plugin_path := "res://addons/godot_control_mcp/plugin.cfg"
	for ignored in range(120):
		if EditorInterface.is_plugin_enabled(plugin_path):
			break
		await process_frame
	_check(EditorInterface.is_plugin_enabled(plugin_path), "editor plugin manager must enable real plugin.cfg")
	var first := await _connect()
	_check(first.get_ready_state() == WebSocketPeer.STATE_OPEN, "plugin _enter_tree must start server")
	EditorInterface.set_plugin_enabled(plugin_path, false)
	for ignored in range(120):
		first.poll()
		if first.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			break
		await process_frame
	_check(first.get_ready_state() == WebSocketPeer.STATE_CLOSED, "plugin _exit_tree must stop server")
	EditorInterface.set_plugin_enabled(plugin_path, true)
	var second := await _connect()
	_check(second.get_ready_state() == WebSocketPeer.STATE_OPEN, "re-enabled plugin must accept connections")
	_check(second.send_text('{"jsonrpc":"2.0","id":9,"method":"core.ping","params":{}}') == OK, "lifecycle ping send must succeed")
	for ignored in range(120):
		second.poll()
		if second.get_available_packet_count() > 0:
			break
		await process_frame
	var response: Dictionary = JSON.parse_string(second.get_packet().get_string_from_utf8())
	_check(response.id == 9 and response.result.pong, "re-enabled plugin must route requests")
	EditorInterface.set_plugin_enabled(plugin_path, false)
	print("PASS editor plugin enter/exit/re-enable")
	quit(0 if failures.is_empty() else 1)
