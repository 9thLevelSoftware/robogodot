extends RefCounted

const MAX_DEPTH := 32
const MAX_NODES := 1000
const MAX_PROPERTIES := 64
const SAFE_PROPERTIES := [&"name", &"process_mode", &"process_priority", &"visible", &"position", &"rotation", &"scale", &"modulate", &"self_modulate", &"z_index"]

func scene_tree(root: Node, params: Dictionary) -> Dictionary:
	var depth: int = clampi(int(params.get("maxDepth", 8)), 0, MAX_DEPTH)
	var nodes: Array = []
	_walk(root, root, 0, depth, nodes, {})
	return {"nodes":nodes, "truncated":nodes.size() >= MAX_NODES}

func _walk(base: Node, node: Node, depth: int, maximum: int, output: Array, visited: Dictionary) -> void:
	if output.size() >= MAX_NODES: return
	var identity := node.get_instance_id(); if visited.has(identity): return
	visited[identity] = true
	output.append({"path":str(base.get_path_to(node)), "name":node.name, "type":node.get_class(), "depth":depth})
	if depth >= maximum: return
	for child in node.get_children(): _walk(base, child, depth + 1, maximum, output, visited)

func get_node(root: Node, params: Dictionary) -> Dictionary:
	var path: Variant = params.get("path", "")
	if not path is String or path.length() > 1024: return {"error":"invalid path"}
	var node := root.get_node_or_null(NodePath(path))
	if node == null: return {"error":"node not found"}
	var requested: Variant = params.get("properties", [])
	if not requested is Array or requested.size() > MAX_PROPERTIES: return {"error":"invalid properties"}
	var properties := {}
	for property in requested:
		if not property is String or property.to_utf8_buffer().size() > 256: return {"error":"invalid property"}
		var allowed := StringName(property) in SAFE_PROPERTIES
		for info in node.get_property_list():
			if info.name == property and int(info.usage) & PROPERTY_USAGE_SCRIPT_VARIABLE != 0: allowed = false; break
		if not allowed: continue
		var raw: Variant = node.get(property); var value := _safe_value(raw)
		if value != null or raw == null: properties[property] = value
	return {"path":str(root.get_path_to(node)), "type":node.get_class(), "properties":properties}

func _safe_value(value: Variant) -> Variant:
	if value == null or value is bool or value is int or value is String: return value
	if value is StringName: return String(value)
	if value is float: return value if is_finite(value) else null
	if value is Vector2: return {"type":"Vector2", "x":value.x, "y":value.y}
	if value is Vector3: return {"type":"Vector3", "x":value.x, "y":value.y, "z":value.z}
	if value is Color: return {"type":"Color", "r":value.r, "g":value.g, "b":value.b, "a":value.a}
	if value is NodePath: return {"type":"NodePath", "value":str(value)}
	return null
