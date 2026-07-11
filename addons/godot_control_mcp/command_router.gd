@tool
extends RefCounted

var _commands: Dictionary = {}

func register_command(command_name: String, command: Callable) -> bool:
	if command_name.is_empty() or not command.is_valid() or _commands.has(command_name):
		return false
	_commands[command_name] = command
	return true

func parse_and_dispatch(text: String) -> Dictionary:
	var json := JSON.new()
	if json.parse(text) != OK:
		return _error(null, -32700, "Parse error", "Send one valid JSON object.")
	return dispatch(json.data)

func dispatch(request: Variant) -> Dictionary:
	if not request is Dictionary:
		return _error(null, -32600, "Invalid Request", "Request must be a JSON object.")
	var id: Variant = request.get("id")
	if request.get("jsonrpc") != "2.0" or not request.has("id") or not (id is String or id is int or id is float):
		return _error(null, -32600, "Invalid Request", "Use jsonrpc 2.0 with a string or numeric id.")
	var method: Variant = request.get("method")
	if not method is String or method.is_empty():
		return _error(id, -32600, "Invalid Request", "Method must be a nonempty string.")
	var params: Variant = request.get("params", {})
	if not params is Dictionary:
		return _error(id, -32602, "Invalid params", "Params must be an object.")
	if not _commands.has(method):
		return _error(id, -32601, "Method not found", "Register the command before calling it.")
	var command: Callable = _commands[method]
	if not command.is_valid():
		return _error(id, -32603, "Internal error", "The registered command is no longer callable.")
	var outcome: Variant = command.call(params)
	if not outcome is Dictionary or not outcome.has("ok") or not outcome.ok is bool:
		return _error(id, -32603, "Internal error", "Command returned an invalid outcome envelope.")
	if not outcome.ok:
		var hint: Variant = outcome.get("hint")
		if not hint is String or hint.is_empty():
			hint = "Command failed without an actionable hint."
		return _error(id, -32603, "Internal error", hint)
	if not outcome.has("result"):
		return _error(id, -32603, "Internal error", "Successful command outcome omitted result.")
	return {"jsonrpc": "2.0", "id": id, "result": outcome.result}

func _error(id: Variant, code: int, message: String, hint: String) -> Dictionary:
	return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message, "data": {"hint": hint}}}
