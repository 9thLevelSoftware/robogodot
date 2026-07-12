@tool
extends RefCounted

static var _resources: Dictionary = {}

static func create(resource: Resource) -> String:
	if resource == null: return ""
	var crypto := Crypto.new()
	for _attempt in range(16):
		var bytes := crypto.generate_random_bytes(16)
		if bytes.size() != 16: return ""
		var token := Marshalls.raw_to_base64(bytes).replace("+", "-").replace("/", "_").trim_suffix("==")
		var handle := "res_%s" % token
		if handle.length() == 26 and not _resources.has(handle):
			_resources[handle] = resource
			return handle
	return ""

func _get(handle: StringName) -> Variant:
	var key := String(handle)
	if not _resources.has(key): return null
	var value = _resources[key]
	return value if value is Resource else null

static func clear() -> void:
	_resources.clear()
