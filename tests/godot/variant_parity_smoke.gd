extends SceneTree

const TypeParse = preload("res://addons/godot_control_mcp/util/type_parse.gd")

func _init() -> void:
	var fixture := JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/variant-vectors.json")) as Dictionary
	var failures: Array[String] = []
	for vector in fixture.valid:
		var parsed: Dictionary = TypeParse.parse_variant_literal(vector.input)
		if not parsed.ok:
			failures.append("%s unexpectedly failed: %s" % [vector.name, parsed.error])
			continue
		var actual: Variant = TypeParse.serialize_variant(parsed.value)
		if JSON.stringify(actual) != JSON.stringify(vector.expected):
			failures.append("%s mismatch: %s != %s" % [vector.name, JSON.stringify(actual), JSON.stringify(vector.expected)])
	for vector in fixture.invalid:
		var parsed: Dictionary = TypeParse.parse_variant_literal(vector.input)
		if parsed.ok or parsed.get("code", "") != "invalid_args" or not vector.contains.to_lower() in str(parsed.get("error", "")).to_lower():
			failures.append("%s did not return actionable invalid_args: %s" % [vector.name, parsed])
	if not failures.is_empty():
		for failure in failures:
			push_error(failure)
		quit(1)
		return
	print("variant parity smoke: %d valid, %d invalid" % [fixture.valid.size(), fixture.invalid.size()])
	quit(0)
