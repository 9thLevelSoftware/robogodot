@tool
extends EditorPlugin

const DEFAULT_PORT := 9200
const Router = preload("command_router.gd")
const Server = preload("ws_server.gd")
const Core = preload("commands/core.gd")
const Exec = preload("commands/exec.gd")
var _server: Node

static func parse_port(value: String) -> int:
	var trimmed := value.strip_edges()
	if not trimmed.is_valid_int():
		return DEFAULT_PORT
	var parsed := trimmed.to_int()
	return parsed if parsed >= 1 and parsed <= 65535 else DEFAULT_PORT

static func is_valid_port_value(value: String) -> bool:
	var trimmed := value.strip_edges()
	if not trimmed.is_valid_int():
		return false
	var parsed := trimmed.to_int()
	return parsed >= 1 and parsed <= 65535

static func port_from_environment() -> int:
	if not OS.has_environment("GODOT_MCP_PORT"):
		return DEFAULT_PORT
	var raw := OS.get_environment("GODOT_MCP_PORT")
	var port := parse_port(raw)
	if not is_valid_port_value(raw):
		push_warning("Invalid GODOT_MCP_PORT '%s'; expected an integer from 1 to 65535. Using 9200." % raw)
	return port

static func token_from_environment() -> String:
	if not OS.has_environment("GODOT_MCP_TOKEN"):
		return ""
	return OS.get_environment("GODOT_MCP_TOKEN")

func _enter_tree() -> void:
	var router := Router.new()
	router.register_command("core.ping", Core.ping)
	router.register_command("core.get_version", Core.get_version)
	router.register_command("exec.run", Exec.run)
	_server = Server.new()
	add_child(_server)
	var port := port_from_environment()
	var token := token_from_environment()
	var token_size := token.to_utf8_buffer().size()
	if token_size < Server.MIN_TOKEN_BYTES or token_size > Server.MAX_TOKEN_BYTES:
		push_error("GODOT_MCP_TOKEN must contain between 32 and 256 UTF-8 bytes; transport disabled.")
		return
	var listen_error: Error = _server.start(port, router, token)
	if listen_error != OK:
		push_error("Godot Control MCP could not listen on 127.0.0.1:%d (error %d)" % [port, listen_error])

func _exit_tree() -> void:
	if is_instance_valid(_server):
		_server.stop()
		_server.queue_free()
	_server = null
