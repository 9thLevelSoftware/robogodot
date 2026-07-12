extends SceneTree

const Plugin = preload("res://addons/godot_control_mcp/plugin.gd")
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _port() -> int:
	return OS.get_environment("GODOT_MCP_PORT").to_int()

func _run() -> void:
	_check(Plugin.token_from_environment().is_empty(), "missing-token smoke must run without GODOT_MCP_TOKEN")
	var plugin_path := "res://addons/godot_control_mcp/plugin.cfg"
	for ignored in range(120):
		if EditorInterface.is_plugin_enabled(plugin_path):
			break
		await process_frame
	_check(EditorInterface.is_plugin_enabled(plugin_path), "real plugin must start before listener assertion")
	var tcp := StreamPeerTCP.new()
	tcp.connect_to_host("127.0.0.1", _port())
	for ignored in range(120):
		tcp.poll()
		if tcp.get_status() != StreamPeerTCP.STATUS_CONNECTING:
			break
		await process_frame
	_check(tcp.get_status() != StreamPeerTCP.STATUS_CONNECTED, "plugin without token must not open a listener")
	_check(EditorInterface.is_plugin_enabled(plugin_path), "missing-token smoke must leave the plugin enabled for the lifecycle smoke")
	print("PASS missing token disables listener and leaves plugin enabled")
	quit(0 if failures.is_empty() else 1)
