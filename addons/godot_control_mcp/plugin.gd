@tool
extends EditorPlugin

const DEFAULT_PORT := 9200
const Router = preload("command_router.gd")
const Server = preload("ws_server.gd")
const Core = preload("commands/core.gd")
const Exec = preload("commands/exec.gd")
const Introspection = preload("commands/introspection.gd")
const Edit = preload("commands/edit.gd")
const Runtime = preload("commands/runtime.gd")
const ResourceHandles = preload("resource_handles.gd")
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
	ResourceHandles.clear()
	var router := Router.new()
	router.register_command("core.ping", Core.ping)
	router.register_command("core.get_version", Core.get_version)
	router.register_command("exec.run", Exec.run)
	router.register_command("introspection.list_classes", Introspection.list_classes)
	router.register_command("introspection.describe_class", Introspection.describe_class)
	router.register_command("introspection.search", Introspection.search)
	router.register_command("edit.node_add", Edit.node_add)
	router.register_command("edit.node_delete", Edit.node_delete)
	router.register_command("edit.node_reparent", Edit.node_reparent)
	router.register_command("edit.node_rename", Edit.node_rename)
	router.register_command("edit.node_duplicate", Edit.node_duplicate)
	router.register_command("edit.node_get", Edit.node_get)
	router.register_command("edit.node_set_property", Edit.node_set_property)
	router.register_command("edit.node_call_readonly", Edit.node_call_readonly)
	router.register_command("edit.node_instance", Edit.node_instance)
	router.register_command("edit.signal_list", Edit.signal_list)
	router.register_command("edit.signal_connect", Edit.signal_connect)
	router.register_command("edit.signal_disconnect", Edit.signal_disconnect)
	router.register_command("edit.scene_open", Edit.scene_open)
	router.register_command("edit.scene_new", Edit.scene_new)
	router.register_command("edit.scene_save", Edit.scene_save)
	router.register_command("edit.scene_tree", Edit.scene_tree)
	router.register_command("edit.scene_current", Edit.scene_current)
	router.register_command("edit.resource_load", Edit.resource_load)
	router.register_command("edit.resource_create", Edit.resource_create)
	router.register_command("edit.resource_save", Edit.resource_save)
	router.register_command("edit.project_setting_get", Edit.project_setting_get)
	router.register_command("edit.project_setting_set", Edit.project_setting_set)
	router.register_command("edit.project_setting_list", Edit.project_setting_list)
	router.register_command("runtime.prepare", Runtime.prepare)
	_server = Server.new()
	_server.session_ended.connect(_on_session_ended)
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
		if _server.session_ended.is_connected(_on_session_ended):
			_server.session_ended.disconnect(_on_session_ended)
		_server.queue_free()
	_server = null
	var cleanup_error := Runtime.cleanup_owned_sessions()
	if cleanup_error != OK: push_warning("Godot Control MCP could not clean one or more exact runtime sessions (error %d)." % cleanup_error)
	ResourceHandles.clear()

func _on_session_ended() -> void:
	var cleanup_error := Runtime.cleanup_owned_sessions()
	if cleanup_error != OK: push_warning("Godot Control MCP could not clean one or more exact runtime sessions (error %d)." % cleanup_error)
	ResourceHandles.clear()
