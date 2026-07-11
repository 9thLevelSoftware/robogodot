@tool
extends EditorPlugin

const DEFAULT_PORT := 9200
const Router = preload("command_router.gd")
const Server = preload("ws_server.gd")
const Core = preload("commands/core.gd")
var _server: Node

static func parse_port(value: String) -> int:
	var trimmed := value.strip_edges()
	if not trimmed.is_valid_int():
		return DEFAULT_PORT
	var parsed := trimmed.to_int()
	return parsed if parsed >= 1 and parsed <= 65535 else DEFAULT_PORT

static func port_from_environment() -> int:
	if not OS.has_environment("GODOT_MCP_PORT"):
		return DEFAULT_PORT
	var raw := OS.get_environment("GODOT_MCP_PORT")
	var port := parse_port(raw)
	if port == DEFAULT_PORT and raw.strip_edges() != str(DEFAULT_PORT):
		push_warning("Invalid GODOT_MCP_PORT '%s'; expected an integer from 1 to 65535. Using 9200." % raw)
	return port

func _enter_tree() -> void:
	var router := Router.new()
	router.register_command("core.ping", Core.ping)
	router.register_command("core.get_version", Core.get_version)
	_server = Server.new()
	add_child(_server)
	var port := port_from_environment()
	var listen_error: Error = _server.start(port, router)
	if listen_error != OK:
		push_error("Godot Control MCP could not listen on 127.0.0.1:%d (error %d)" % [port, listen_error])

func _exit_tree() -> void:
	if is_instance_valid(_server):
		_server.stop()
		_server.queue_free()
	_server = null
