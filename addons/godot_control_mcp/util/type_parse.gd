class_name GodotMCPTypeParse
extends RefCounted

const TAG := "$type"
const MAX_VARIANT_DEPTH := 32
const MAX_VARIANT_NODES := 10000

static func _error(message: String) -> Dictionary:
	return {"ok": false, "code": "invalid_args", "error": message}

static func _ok(value: Variant) -> Dictionary:
	return {"ok": true, "value": value}

static func _finite(value: Variant, context: String) -> Dictionary:
	if not (value is int or value is float) or not is_finite(float(value)):
		return _error("%s must be a finite number" % context)
	return _ok(value)

static func _number(text: String, context: String) -> Dictionary:
	var cleaned := text.strip_edges()
	var number_pattern := RegEx.create_from_string("^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
	if cleaned.is_empty() or number_pattern.search(cleaned) == null:
		return _error("%s must be a finite number" % context)
	var value := cleaned.to_float()
	if not is_finite(value):
		return _error("%s must be a finite number" % context)
	return _ok(value)

static func _keys_exact(value: Dictionary, expected: Array[String], context: String) -> Dictionary:
	if value.size() != expected.size():
		return _error("%s must contain exactly %s" % [context, ", ".join(expected)])
	for key in expected:
		if not value.has(key):
			return _error("%s must contain exactly %s" % [context, ", ".join(expected)])
	return _ok(null)

static func _parse_tagged(value: Dictionary) -> Dictionary:
	if not value.get(TAG) is String:
		return _error("tagged Variant $type must be a string")
	var type: String = value[TAG]
	var keys: Dictionary
	if type == "Vector2":
		keys = _keys_exact(value, [TAG, "x", "y"], type)
		if not keys.ok: return keys
		var x := _finite(value.x, "Vector2.x"); if not x.ok: return x
		var y := _finite(value.y, "Vector2.y"); if not y.ok: return y
		return _ok(Vector2(x.value, y.value))
	if type == "Vector3":
		keys = _keys_exact(value, [TAG, "x", "y", "z"], type)
		if not keys.ok: return keys
		var x := _finite(value.x, "Vector3.x"); if not x.ok: return x
		var y := _finite(value.y, "Vector3.y"); if not y.ok: return y
		var z := _finite(value.z, "Vector3.z"); if not z.ok: return z
		return _ok(Vector3(x.value, y.value, z.value))
	if type == "Color":
		keys = _keys_exact(value, [TAG, "r", "g", "b", "a"], type)
		if not keys.ok: return keys
		var channels: Array[float] = []
		for channel in ["r", "g", "b", "a"]:
			var checked := _finite(value[channel], "Color.%s" % channel)
			if not checked.ok: return checked
			channels.append(checked.value)
		return _ok(Color(channels[0], channels[1], channels[2], channels[3]))
	if type == "NodePath":
		keys = _keys_exact(value, [TAG, "path"], type)
		if not keys.ok: return keys
		if not value.path is String: return _error("NodePath.path must be a string")
		return _ok(NodePath(value.path))
	if type == "Rect2":
		keys = _keys_exact(value, [TAG, "x", "y", "width", "height"], type)
		if not keys.ok: return keys
		var values: Array[float] = []
		for field in ["x", "y", "width", "height"]:
			var checked := _finite(value[field], "Rect2.%s" % field)
			if not checked.ok: return checked
			values.append(checked.value)
		return _ok(Rect2(values[0], values[1], values[2], values[3]))
	return _error("unknown tagged Variant '%s'" % type)

static func _count_parse(state: Dictionary, depth: int) -> Dictionary:
	if depth > MAX_VARIANT_DEPTH: return _error("Variant literal exceeds maximum depth %d" % MAX_VARIANT_DEPTH)
	state.nodes += 1
	if state.nodes > MAX_VARIANT_NODES: return _error("Variant literal exceeds node budget %d" % MAX_VARIANT_NODES)
	return _ok(null)

static func _parse_structured(value: Variant, state := {"nodes": 0}, depth := 0) -> Dictionary:
	var counted := _count_parse(state, depth)
	if not counted.ok: return counted
	if value == null or value is bool or value is String:
		return _ok(value)
	if value is int or value is float:
		return _finite(value, "JSON number")
	if value is Array:
		var output: Array = []
		for item in value:
			var parsed := _parse_structured(item, state, depth + 1)
			if not parsed.ok: return parsed
			output.append(parsed.value)
		return _ok(output)
	if value is Dictionary:
		if value.has(TAG): return _parse_tagged(value)
		var output := {}
		for key in value:
			var parsed := _parse_structured(value[key], state, depth + 1)
			if not parsed.ok: return parsed
			output[key] = parsed.value
		return _ok(output)
	return _error("unsupported Variant literal value of type %s" % type_string(typeof(value)))

static func _constructor(text: String) -> Dictionary:
	var open := text.find("(")
	if open < 1: return _error("unknown constructor or malformed Variant literal")
	var name := text.substr(0, open).strip_edges()
	var close := text.rfind(")")
	if close < open: return _error("%s is missing ')'" % name)
	if not text.substr(close + 1).strip_edges().is_empty(): return _error("trailing junk after %s constructor" % name)
	var body := text.substr(open + 1, close - open - 1).strip_edges()
	if name == "NodePath":
		var json := JSON.new()
		if json.parse(body) != OK or not json.data is String: return _error("NodePath expects one quoted JSON string")
		return _ok(NodePath(json.data))
	var arities := {"Vector2": [2], "Vector3": [3], "Color": [3, 4], "Rect2": [4]}
	if not arities.has(name): return _error("unknown constructor '%s'" % name)
	var parts := PackedStringArray() if body.is_empty() else body.split(",")
	if not parts.size() in arities[name]:
		var expected := "3 or 4" if name == "Color" else str(arities[name][0])
		return _error("%s expects %s arguments, received %d" % [name, expected, parts.size()])
	var numbers: Array[float] = []
	for index in parts.size():
		var parsed := _number(parts[index], "%s argument %d" % [name, index + 1])
		if not parsed.ok: return parsed
		numbers.append(parsed.value)
	match name:
		"Vector2": return _ok(Vector2(numbers[0], numbers[1]))
		"Vector3": return _ok(Vector3(numbers[0], numbers[1], numbers[2]))
		"Rect2": return _ok(Rect2(numbers[0], numbers[1], numbers[2], numbers[3]))
		_: return _ok(Color(numbers[0], numbers[1], numbers[2], numbers[3] if numbers.size() == 4 else 1.0))

static func parse_variant_literal(value: Variant) -> Dictionary:
	var state := {"nodes": 0}
	if not value is String: return _parse_structured(value, state)
	var text: String = value.strip_edges()
	if text.begins_with("("): return _error("ambiguous tuple syntax; use an explicit Vector2 or other constructor")
	if text.begins_with("#"):
		var hex: String = text.substr(1)
		if hex.length() != 6 and hex.length() != 8: return _error("hex Color expects exactly 6 or 8 hexadecimal digits")
		for character in hex:
			if not character.to_lower() in "0123456789abcdef": return _error("hex Color expects exactly 6 or 8 hexadecimal digits")
		return _ok(Color.from_string(text, Color.TRANSPARENT))
	var open: int = text.find("(")
	if open > 0 and (text[0].to_lower() != text[0] or text[0] == "_"): return _constructor(text)
	var json := JSON.new()
	if json.parse(text) != OK: return _error("invalid JSON or unknown constructor Variant literal")
	return _parse_structured(json.data, state)

static func _color_number(value: float) -> float:
	return float("%.7f" % value)

static func _unknown(variant_type: String, value: String) -> Dictionary:
	return {TAG: "UnknownVariant", "variantType": variant_type, "value": value}

static func _is_ancestor(value: Variant, ancestors: Array) -> bool:
	for ancestor in ancestors:
		if is_same(ancestor, value): return true
	return false

static func _serialize(value: Variant, state: Dictionary, depth: int, ancestors: Array) -> Variant:
	if depth > MAX_VARIANT_DEPTH: return _unknown("depth overflow", "maximum depth %d" % MAX_VARIANT_DEPTH)
	state.nodes += 1
	if state.nodes > MAX_VARIANT_NODES: return _unknown("node budget overflow", "maximum nodes %d" % MAX_VARIANT_NODES)
	if (value is Array or value is Dictionary) and _is_ancestor(value, ancestors):
		return _unknown("cycle", "Array" if value is Array else "Dictionary")
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else _unknown("nonfinite number", str(value))
		TYPE_VECTOR2:
			return {TAG: "Vector2", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {TAG: "Vector3", "x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {TAG: "Color", "r": _color_number(value.r), "g": _color_number(value.g), "b": _color_number(value.b), "a": _color_number(value.a)}
		TYPE_NODE_PATH:
			return {TAG: "NodePath", "path": str(value)}
		TYPE_RECT2:
			return {TAG: "Rect2", "x": value.position.x, "y": value.position.y, "width": value.size.x, "height": value.size.y}
		TYPE_ARRAY:
			ancestors.append(value)
			var output: Array = []
			for item in value: output.append(_serialize(item, state, depth + 1, ancestors))
			ancestors.pop_back()
			return output
		TYPE_DICTIONARY:
			ancestors.append(value)
			var output := {}
			for key in value: output[str(key)] = _serialize(value[key], state, depth + 1, ancestors)
			ancestors.pop_back()
			return output
		TYPE_OBJECT:
			if not is_instance_valid(value): return {TAG: "Object", "class": "<freed>", "instanceId": 0}
			var description := {TAG: "Resource" if value is Resource else "Object", "class": value.get_class(), "instanceId": value.get_instance_id()}
			if value is Node: description.nodePath = str(value.get_path())
			if value is Resource and not value.resource_path.is_empty():
				description.resourcePath = value.resource_path
				var uid := ResourceLoader.get_resource_uid(value.resource_path)
				if uid != ResourceUID.INVALID_ID: description.uid = ResourceUID.id_to_text(uid)
			return description
		_:
			return _unknown(type_string(typeof(value)), str(value))

static func serialize_variant(value: Variant) -> Variant:
	return _serialize(value, {"nodes": 0}, 0, [])
