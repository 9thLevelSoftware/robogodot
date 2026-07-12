extends SceneTree

const TypeParse = preload("res://addons/godot_control_mcp/util/type_parse.gd")

func _initialize() -> void:
	call_deferred("_run")

func _run() -> void:
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
	var at_depth: Variant = 1
	for ignored in TypeParse.MAX_VARIANT_DEPTH: at_depth = [at_depth]
	if not TypeParse.parse_variant_literal(at_depth).ok: failures.append("exact depth boundary must parse")
	if TypeParse.parse_variant_literal([at_depth]).ok: failures.append("depth overflow must return invalid_args")
	var at_budget := []
	at_budget.resize(TypeParse.MAX_VARIANT_NODES - 1)
	at_budget.fill(null)
	if not TypeParse.parse_variant_literal(at_budget).ok: failures.append("exact node boundary must parse")
	at_budget.append(null)
	if TypeParse.parse_variant_literal(at_budget).ok: failures.append("node overflow must return invalid_args")
	var repeated := {"value": 1}
	if TypeParse.serialize_variant([repeated, repeated]) != [{"value": 1}, {"value": 1}]: failures.append("repeated references must not be cycles")
	var cycle := []
	cycle.append(cycle)
	var cycle_serialized: Array = TypeParse.serialize_variant(cycle)
	if cycle_serialized[0].get("variantType") != "cycle": failures.append("array cycle must be described")
	var dictionary_cycle := {}
	dictionary_cycle.self = dictionary_cycle
	if TypeParse.serialize_variant(dictionary_cycle).self.get("variantType") != "cycle": failures.append("dictionary cycle must be described")
	var deep: Variant = 1
	for ignored in TypeParse.MAX_VARIANT_DEPTH: deep = [deep]
	if TypeParse.serialize_variant(deep) != deep: failures.append("exact serialization depth boundary must pass")
	deep = [deep]
	if not "depth overflow" in JSON.stringify(TypeParse.serialize_variant(deep)): failures.append("serialization depth overflow must be described")
	at_budget.pop_back()
	if "overflow" in JSON.stringify(TypeParse.serialize_variant(at_budget)): failures.append("exact serialization node boundary must pass")
	at_budget.append(null)
	if not "node budget overflow" in JSON.stringify(TypeParse.serialize_variant(at_budget)): failures.append("serialization node overflow must be described")
	var node := Node.new()
	node.name = "ParityNode"
	root.add_child(node)
	var node_description: Dictionary = TypeParse.serialize_variant(node)
	if node_description.get("class") != "Node" or node_description.get("instanceId") != node.get_instance_id() or node_description.get("nodePath") != "/root/ParityNode": failures.append("Node description must include class, instance id, and path")
	node.free()
	var resource := Resource.new()
	resource.take_over_path("res://tests/fixtures/runtime-resource.tres")
	var resource_description: Dictionary = TypeParse.serialize_variant(resource)
	if resource_description.get("class") != "Resource" or resource_description.get("resourcePath") != resource.resource_path: failures.append("Resource description must include class and path")
	var resource_uid := ResourceLoader.get_resource_uid(resource.resource_path)
	if resource_uid != ResourceUID.INVALID_ID and resource_description.get("uid") != ResourceUID.id_to_text(resource_uid): failures.append("Resource description must include UID when supported")
	var unsupported: Dictionary = TypeParse.serialize_variant(RID())
	if unsupported.get("$type") != "UnknownVariant" or unsupported.get("variantType") == "": failures.append("unsupported Variant must be described")
	for nonfinite in [NAN, INF, -INF]:
		var cases: Array[Dictionary] = [
			{"name": "Vector2.x", "type": "Vector2", "value": Vector2(nonfinite, 1.0)},
			{"name": "Vector2.y", "type": "Vector2", "value": Vector2(1.0, nonfinite)},
			{"name": "Vector3.x", "type": "Vector3", "value": Vector3(nonfinite, 1.0, 2.0)},
			{"name": "Vector3.y", "type": "Vector3", "value": Vector3(1.0, nonfinite, 2.0)},
			{"name": "Vector3.z", "type": "Vector3", "value": Vector3(1.0, 2.0, nonfinite)},
			{"name": "Color.r", "type": "Color", "value": Color(nonfinite, 0.25, 0.5, 1.0)},
			{"name": "Color.g", "type": "Color", "value": Color(0.25, nonfinite, 0.5, 1.0)},
			{"name": "Color.b", "type": "Color", "value": Color(0.25, 0.5, nonfinite, 1.0)},
			{"name": "Color.a", "type": "Color", "value": Color(0.25, 0.5, 1.0, nonfinite)},
			{"name": "Rect2.x", "type": "Rect2", "value": Rect2(nonfinite, 1.0, 2.0, 3.0)},
			{"name": "Rect2.y", "type": "Rect2", "value": Rect2(1.0, nonfinite, 2.0, 3.0)},
			{"name": "Rect2.width", "type": "Rect2", "value": Rect2(1.0, 2.0, nonfinite, 3.0)},
			{"name": "Rect2.height", "type": "Rect2", "value": Rect2(1.0, 2.0, 3.0, nonfinite)},
		]
		for case in cases:
			var serialized: Dictionary = TypeParse.serialize_variant(case.value)
			if serialized.get("$type") != "UnknownVariant" or serialized.get("variantType") != case.type:
				failures.append("%s with %s must serialize as UnknownVariant: %s" % [case.name, str(nonfinite), serialized])
	if not failures.is_empty():
		for failure in failures:
			push_error(failure)
		quit(1)
		return
	print("variant parity smoke: %d valid, %d invalid" % [fixture.valid.size(), fixture.invalid.size()])
	print("PASS variant parity")
	quit(0)
