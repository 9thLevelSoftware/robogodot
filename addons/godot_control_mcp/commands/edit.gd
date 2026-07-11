@tool
extends RefCounted

const TypeParse = preload("../util/type_parse.gd")
const EditController = preload("../edit_controller.gd")
const Compat = preload("../godot_compat.gd")

static func _root() -> Node:
	return Compat.edited_scene_root()

static func _node(path: Variant) -> Node:
	var root := _root()
	if root == null or not path is String: return null
	var canonical := String(path)
	var prefix := "/root/%s" % root.name
	if canonical == prefix: return root if _path(root) == canonical else null
	if not canonical.begins_with(prefix + "/"): return null
	var resolved := root.get_node_or_null(canonical.substr(prefix.length() + 1))
	return resolved if resolved != null and _path(resolved) == canonical else null

static func _controller() -> RefCounted:
	return EditController.new(Compat.editor_undo_redo())

static func _success(value: Dictionary) -> Dictionary: return {"ok": true, "result": value}
static func _failure(hint: String) -> Dictionary: return {"ok": false, "hint": hint}
static func _path(node: Node) -> String:
	var root := _root()
	if root == null or (node != root and not root.is_ancestor_of(node)): return str(node.get_path())
	var prefix := "/root/%s" % root.name
	return prefix if node == root else "%s/%s" % [prefix, root.get_path_to(node)]

static func node_add(params: Dictionary) -> Dictionary:
	var parent := _node(params.get("parent"))
	var type = params.get("type"); var name = params.get("name")
	if parent == null or not type is String or not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, "Node") or not name is String or name.is_empty() or name.validate_node_name() != name:
		return _failure("Provide a valid parent, Node class, and node name.")
	var node: Node = ClassDB.instantiate(type)
	node.name = name
	for property in params.get("properties", {}):
		var descriptor := _property(node, StringName(property))
		if descriptor.is_empty(): node.free(); return _failure("Unknown or read-only property '%s'." % property)
		var parsed := TypeParse.parse_variant_literal(params.properties[property])
		if not parsed.ok: node.free(); return _failure(parsed.error)
		if not _value_matches(parsed.value, descriptor): node.free(); return _failure("Property '%s' requires %s." % [property, type_string(int(descriptor.type))])
		node.set(property, parsed.value)
	var applied: Dictionary = _controller().add_node(parent, node, "Add %s" % name)
	if not applied.ok: node.free(); return applied
	_set_owner_recursive(node, _root())
	return _success({"path": _path(node)})

static func node_delete(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path"))
	if node == null or node == _root(): return _failure("Provide a non-root node path.")
	var path := _path(node); var result: Dictionary = _controller().delete_node(node, "Delete %s" % node.name)
	return _success({"path": path}) if result.ok else result

static func node_reparent(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path")); var parent := _node(params.get("parent"))
	if node == null or parent == null: return _failure("Provide valid node and parent paths.")
	var result: Dictionary = _controller().reparent_node(node, parent, int(params.get("index", -1)), "Reparent %s" % node.name)
	return _success({"path": _path(node)}) if result.ok else result

static func node_rename(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path")); var name = params.get("name")
	if node == null or not name is String: return _failure("Provide a valid node path and name.")
	var result: Dictionary = _controller().rename_node(node, name, "Rename %s" % node.name)
	return _success({"path": _path(node)}) if result.ok else result

static func node_duplicate(params: Dictionary) -> Dictionary:
	var source := _node(params.get("path")); var parent := _node(params.get("parent", params.get("path")))
	if source != null and not params.has("parent"): parent = source.get_parent()
	if source == null or parent == null: return _failure("Provide valid source and parent paths.")
	var result: Dictionary = _controller().duplicate_node(source, parent, int(params.get("flags", 15)), String(params.get("name", "")), "Duplicate %s" % source.name)
	if not result.ok: return result
	_set_owner_recursive(result.node, _root())
	return _success({"path": _path(result.node)})

static func node_get(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path")); if node == null: return _failure(_tree_hint())
	var properties := {}; for entry in node.get_property_list():
		if int(entry.usage) & PROPERTY_USAGE_STORAGE: properties[String(entry.name)] = TypeParse.serialize_variant(node.get(entry.name))
	return _success({"path": _path(node), "class": node.get_class(), "name": node.name, "childCount": node.get_child_count(), "properties": properties})

static func node_set_property(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path")); var property = params.get("property")
	var descriptor := _property(node, StringName(property)) if node != null and property is String else {}
	if node == null or not property is String or descriptor.is_empty(): return _failure("Provide a live node and writable property.")
	var parsed := TypeParse.parse_variant_literal(params.get("value")); if not parsed.ok: return _failure(parsed.error)
	if not _value_matches(parsed.value, descriptor): return _failure("Property '%s' requires %s." % [property, type_string(int(descriptor.type))])
	var before: Variant = TypeParse.serialize_variant(node.get(property)); var result: Dictionary = _controller().set_property(node, StringName(property), parsed.value, "Set %s" % property)
	return _success({"path": _path(node), "property": property, "before": before, "after": TypeParse.serialize_variant(node.get(property))}) if result.ok else result

static func node_call_readonly(params: Dictionary) -> Dictionary:
	var node := _node(params.get("path")); var method = params.get("method"); var args = params.get("args", [])
	if node == null or not method in ["get_path", "get_child_count", "is_inside_tree"] or not args is Array or not args.is_empty(): return _failure("Only the zero-argument read-only method allowlist is supported.")
	return _success({"path": _path(node), "method": method, "value": TypeParse.serialize_variant(node.call(method))})

static func _property(node: Node, name: StringName) -> Dictionary:
	for entry in node.get_property_list():
		if StringName(entry.name) == name and int(entry.usage) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR) and not int(entry.usage) & PROPERTY_USAGE_READ_ONLY: return entry
	return {}
static func _set_owner_recursive(node: Node, owner: Node) -> void:
	if owner == node or owner.is_ancestor_of(node): node.owner = owner
	for child in node.get_children(): _set_owner_recursive(child, owner)
static func _value_matches(value: Variant, descriptor: Dictionary) -> bool:
	var expected := int(descriptor.get("type", TYPE_NIL))
	if value == null: return expected in [TYPE_NIL, TYPE_OBJECT]
	if expected == TYPE_FLOAT and value is int: return true
	if typeof(value) != expected: return false
	if expected == TYPE_OBJECT and value != null:
		var required := String(descriptor.get("class_name", ""))
		return required.is_empty() or (value is Object and value.is_class(required))
	return true
static func _tree_hint() -> String:
	var root := _root()
	if root == null: return "Node path is stale. Current tree: <empty>"
	var lines: Array[String] = []
	_append_tree(root, lines, 0)
	var rendered := "Node path is stale. Current tree:\n" + "\n".join(lines)
	return rendered.substr(0, 2048)
static func _append_tree(node: Node, lines: Array[String], depth: int) -> void:
	if lines.size() >= 64: return
	lines.append("  ".repeat(depth) + _path(node))
	for child in node.get_children(): _append_tree(child, lines, depth + 1)
