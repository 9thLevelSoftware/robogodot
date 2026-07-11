@tool
extends EditorPlugin

const DEFAULT_PORT := 9200
const Router = preload("command_router.gd")
const Server = preload("ws_server.gd")
const Core = preload("commands/core.gd")
var _server: Node

func _enter_tree() -> void:
	var router := Router.new()
	router.register_command("core.ping", Core.ping)
	router.register_command("core.get_version", Core.get_version)
	_server = Server.new()
	add_child(_server)
	var port := DEFAULT_PORT
	if OS.has_environment("GODOT_MCP_PORT"):
		port = OS.get_environment("GODOT_MCP_PORT").to_int()
	var listen_error := _server.start(port, router)
	if listen_error != OK:
		push_error("Godot Control MCP could not listen on 127.0.0.1:%d (error %d)" % [port, listen_error])

func _exit_tree() -> void:
	if is_instance_valid(_server):
		_server.stop()
		_server.queue_free()
	_server = null
