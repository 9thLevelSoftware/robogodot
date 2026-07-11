@tool
extends RefCounted

const DEFAULT_OUTPUT_CAP_BYTES := 262144
const MAX_ERROR_ENTRIES := 128
# Reserves 2048 bytes for JSON-RPC keys plus a 128-byte request id at worst-case JSON escaping.
const MAX_RESULT_JSON_BYTES := 260096
const TYPE_PARSE_PATH := "res://addons/godot_control_mcp/util/type_parse.gd"

class CaptureLogger extends Logger:
	var stdout := ""
	var errors: Array[String] = []
	var cap_bytes := DEFAULT_OUTPUT_CAP_BYTES
	var used_bytes := 0
	var truncated := false
	var saw_error := false
	var mutex := Mutex.new()

	func _append_bounded(text: String) -> String:
		var bytes := text.to_utf8_buffer()
		var remaining := maxi(0, cap_bytes - used_bytes)
		if bytes.size() <= remaining:
			used_bytes += bytes.size()
			return text
		truncated = true
		var end := remaining
		while end > 0 and (bytes[end] & 0xc0) == 0x80:
			end -= 1
		if end == 0: return ""
		used_bytes += end
		return bytes.slice(0, end).get_string_from_utf8()

	func _log_message(message: String, error: bool) -> void:
		var normalized := _redact(message)
		if not normalized.ends_with("\n"): normalized += "\n"
		mutex.lock()
		if error: saw_error = true
		var captured := _append_bounded(normalized)
		if error and not captured.is_empty() and errors.size() < MAX_ERROR_ENTRIES: errors.append(captured)
		elif error and errors.size() >= MAX_ERROR_ENTRIES: truncated = true
		else: stdout += captured
		mutex.unlock()

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, _error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		var detail := _redact(rationale if not rationale.is_empty() else code)
		var location := "%s:%d" % [file.get_file(), line] if not file.is_empty() else function
		mutex.lock()
		saw_error = true
		var captured := _append_bounded("%s: %s" % [location, detail])
		if not captured.is_empty() and errors.size() < MAX_ERROR_ENTRIES: errors.append(captured)
		elif errors.size() >= MAX_ERROR_ENTRIES: truncated = true
		mutex.unlock()

	func _redact(text: String) -> String:
		var project_path := ProjectSettings.globalize_path("res://").trim_suffix("/").trim_suffix("\\")
		var redacted := text
		if not project_path.is_empty():
			redacted = redacted.replace(project_path + "/", "res://")
			redacted = redacted.replace(project_path + "\\", "res://")
			if redacted == project_path: redacted = "res://"
		var windows_path := RegEx.create_from_string("(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/][^\\r\\n\"']*")
		redacted = windows_path.sub(redacted, "[host-path]", true)
		var unc_path := RegEx.create_from_string("(?<![A-Za-z0-9_:])(?:\\\\\\\\|//)[^\\r\\n\"'\\\\/]+[\\\\/][^\\r\\n\"']*")
		redacted = unc_path.sub(redacted, "[host-path]", true)
		var unix_path := RegEx.create_from_string("(?<![A-Za-z0-9_:/])/(?:Users|home|tmp|var|private)(?=/|\\s|$)[^\\r\\n\"']*")
		return unix_path.sub(redacted, "[host-path]", true)

static func _finish(result: Dictionary, started: int) -> Dictionary:
	result.elapsedMs = (Time.get_ticks_usec() - started) / 1000.0
	if JSON.stringify(result).to_utf8_buffer().size() > MAX_RESULT_JSON_BYTES:
		result.returnValue = null
		result.truncated = true
	while JSON.stringify(result).to_utf8_buffer().size() > MAX_RESULT_JSON_BYTES and not result.errors.is_empty():
		result.errors.pop_back()
	while JSON.stringify(result).to_utf8_buffer().size() > MAX_RESULT_JSON_BYTES and not result.stdout.is_empty():
		result.stdout = result.stdout.left(maxi(0, result.stdout.length() - 256))
	return {"ok": true, "result": result}

static func run(params: Dictionary) -> Dictionary:
	var started := Time.get_ticks_usec()
	var result := {"ok": false, "returnValue": null, "stdout": "", "errors": [], "elapsedMs": 0, "truncated": false}
	var source: Variant = params.get("source")
	if not source is String or source.is_empty():
		result.errors = ["source must be a nonempty string defining func __run(args):"]
		return _finish(result, started)
	var contract := RegEx.create_from_string("(?m)^\\s*func\\s+__run\\s*\\(\\s*args\\s*\\)\\s*(?:->[^:]*)?:")
	if contract.search(source) == null:
		result.errors = ["source must define func __run(args):"]
		return _finish(result, started)
	var cap: Variant = params.get("outputCapBytes", DEFAULT_OUTPUT_CAP_BYTES)
	if not (cap is int or cap is float) or not is_finite(float(cap)) or cap < 0 or cap > DEFAULT_OUTPUT_CAP_BYTES or floor(float(cap)) != float(cap):
		result.errors = ["outputCapBytes must be an integer from 0 to 262144"]
		return _finish(result, started)
	cap = int(cap)
	var type_parse: Script = load(TYPE_PARSE_PATH)
	if type_parse == null:
		result.errors = ["Variant parser is unavailable"]
		return _finish(result, started)
	var parsed: Dictionary = type_parse.parse_variant_literal(params.get("args", null))
	if not parsed.ok:
		result.errors = [parsed.error]
		return _finish(result, started)

	var capture := CaptureLogger.new()
	capture.cap_bytes = cap
	OS.add_logger(capture)
	var script := GDScript.new()
	script.source_code = source if source.lstrip(" \t\r\n").begins_with("@tool") else "@tool\n" + source
	var reload_error := script.reload()
	var return_value: Variant = null
	if reload_error == OK and script.can_instantiate():
		var instance: Variant = script.new()
		if instance != null and instance.has_method("__run"):
			return_value = instance.call("__run", parsed.value)
		else:
			capture.saw_error = true
			if capture.errors.size() < MAX_ERROR_ENTRIES: capture.errors.append("source must define func __run(args):")
	OS.remove_logger(capture)
	if reload_error == OK and not capture.saw_error:
		result.returnValue = type_parse.serialize_variant(return_value)
	result.stdout = capture.stdout
	result.errors = capture.errors
	result.truncated = capture.truncated
	result.ok = reload_error == OK and not capture.saw_error and result.errors.is_empty()
	return _finish(result, started)
