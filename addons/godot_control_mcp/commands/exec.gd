@tool
extends RefCounted

const DEFAULT_OUTPUT_CAP_BYTES := 262144
const TYPE_PARSE_PATH := "res://addons/godot_control_mcp/util/type_parse.gd"

class CaptureLogger extends Logger:
	var stdout := ""
	var errors: Array[String] = []
	var cap_bytes := DEFAULT_OUTPUT_CAP_BYTES
	var used_bytes := 0
	var truncated := false
	var mutex := Mutex.new()

	func _append_bounded(text: String) -> String:
		var output := ""
		for character in text:
			var size := character.to_utf8_buffer().size()
			if used_bytes + size > cap_bytes:
				truncated = true
				break
			output += character
			used_bytes += size
		if output.length() < text.length(): truncated = true
		return output

	func _log_message(message: String, error: bool) -> void:
		mutex.lock()
		var captured := _append_bounded(message + "\n")
		if error: errors.append(captured)
		else: stdout += captured
		mutex.unlock()

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, _error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		mutex.lock()
		var detail := rationale if not rationale.is_empty() else code
		var location := "%s:%d" % [file, line] if not file.is_empty() else function
		errors.append(_append_bounded("%s: %s" % [location, detail]))
		mutex.unlock()

static func run(params: Dictionary) -> Dictionary:
	var started := Time.get_ticks_usec()
	var result := {"ok": false, "returnValue": null, "stdout": "", "errors": [], "elapsedMs": 0, "truncated": false}
	var source: Variant = params.get("source")
	if not source is String or source.is_empty():
		result.errors = ["source must be a nonempty string defining func __run(args):"]
		return {"ok": true, "result": result}
	var contract := RegEx.create_from_string("(?m)^\\s*func\\s+__run\\s*\\(\\s*args\\s*\\)\\s*(?:->[^:]*)?:")
	if contract.search(source) == null:
		result.errors = ["source must define func __run(args):"]
		return {"ok": true, "result": result}
	var cap: Variant = params.get("outputCapBytes", DEFAULT_OUTPUT_CAP_BYTES)
	if not (cap is int or cap is float) or not is_finite(float(cap)) or cap < 0 or floor(float(cap)) != float(cap):
		result.errors = ["outputCapBytes must be a nonnegative integer"]
		return {"ok": true, "result": result}
	cap = int(cap)
	var type_parse: Script = load(TYPE_PARSE_PATH)
	if type_parse == null:
		result.errors = ["Variant parser is unavailable"]
		return {"ok": true, "result": result}
	var parsed: Dictionary = type_parse.parse_variant_literal(params.get("args", null))
	if not parsed.ok:
		result.errors = [parsed.error]
		return {"ok": true, "result": result}

	var capture := CaptureLogger.new()
	capture.cap_bytes = cap
	OS.add_logger(capture)
	var script := GDScript.new()
	script.source_code = source if source.lstrip(" \t\r\n").begins_with("@tool") else "@tool\n" + source
	var reload_error := script.reload()
	if reload_error == OK and script.can_instantiate():
		var instance: Variant = script.new()
		if instance != null and instance.has_method("__run"):
			var value: Variant = instance.call("__run", parsed.value)
			result.returnValue = type_parse.serialize_variant(value)
		else:
			capture.errors.append("source must define func __run(args):")
	OS.remove_logger(capture)
	result.stdout = capture.stdout
	result.errors = capture.errors
	result.truncated = capture.truncated
	result.elapsedMs = (Time.get_ticks_usec() - started) / 1000.0
	result.ok = reload_error == OK and result.errors.is_empty()
	return {"ok": true, "result": result}
