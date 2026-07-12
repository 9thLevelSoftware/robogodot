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

static func scene_current(_params: Dictionary) -> Dictionary:
	return _success({"path": Compat.current_scene_path(), "unsaved": Compat.scene_is_unsaved()})

static func scene_open(params: Dictionary) -> Dictionary:
	var path := Compat.canonical_project_path(params.get("path"))
	if path.is_empty() or not FileAccess.file_exists(path): return _failure("Provide an existing canonical res:// scene path.")
	if Compat.scene_is_unsaved() and not bool(params.get("discardUnsaved", false)): return _failure("Current scene has unsaved changes; set discardUnsaved true to discard them.")
	Compat.scene_open(path)
	return _success({"path": path, "unsaved": false})

static func scene_new(params: Dictionary) -> Dictionary:
	if Compat.scene_is_unsaved() and not bool(params.get("discardUnsaved", false)): return _failure("Current scene has unsaved changes; set discardUnsaved true to discard them.")
	var type = params.get("rootType", "Node"); var name = params.get("rootName", "Root")
	if not type is String or not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, "Node") or not name is String or name.is_empty() or name.validate_node_name() != name:
		return _failure("Provide a valid Node root type and root name.")
	var root: Node = ClassDB.instantiate(type); root.name = name
	var error := Compat.scene_new(root)
	if error != OK: root.free(); return _failure("Godot could not create the scene with the public editor lifecycle API (error %d)." % error)
	return _success({"path": "", "unsaved": true})

static func scene_save(params: Dictionary) -> Dictionary:
	if _root() == null: return _failure("There is no edited scene to save.")
	var current := Compat.current_scene_path(); var requested = params.get("path", current)
	var path := Compat.canonical_project_path(requested)
	if path.is_empty(): return _failure("Provide a canonical res:// save path.")
	if FileAccess.file_exists(path) and path != current and not bool(params.get("overwrite", false)):
		return _failure("The different target path already exists; set overwrite true to replace it.")
	var error := Compat.scene_save("" if path == current else path)
	if error != OK: return _failure("Godot could not save the scene (error %d)." % error)
	return _success({"path": path, "unsaved": false})

static func scene_tree(params: Dictionary) -> Dictionary:
	var root := _root() if not params.has("root") else _node(params.get("root"))
	if root == null: return _failure("Provide a live root in the edited scene.")
	var max_depth := clampi(int(params.get("maxDepth", 8)), 1, 32)
	var limit := clampi(int(params.get("limit", 100)), 1, 500)
	var cursor_text := String(params.get("cursor", "0"))
	if not cursor_text.is_valid_int() or cursor_text.to_int() < 0: return _failure("Cursor must be a non-negative traversal offset.")
	var offset := cursor_text.to_int(); var flattened: Array[Dictionary] = []
	var stack: Array[Dictionary] = [{"node": root, "depth": 0}]
	while not stack.is_empty():
		var entry := stack.pop_back() as Dictionary; var node := entry.node as Node; var depth := int(entry.depth)
		var child_entries: Array[Dictionary] = []
		if depth < max_depth:
			var children := node.get_children()
			for child in children: child_entries.append({"name": String(child.name), "class": child.get_class(), "path": _path(child), "children": []})
			for index in range(children.size() - 1, -1, -1): stack.append({"node": children[index], "depth": depth + 1})
		flattened.append({"name": String(node.name), "class": node.get_class(), "path": _path(node), "children": child_entries})
	var nodes: Array[Dictionary] = []; var index := offset
	while index < flattened.size() and nodes.size() < limit:
		var candidate: Array[Dictionary] = nodes.duplicate(); candidate.append(flattened[index])
		var probe := {"nodes": candidate, "truncated": index + 1 < flattened.size(), "nextCursor": str(index + 1)}
		if JSON.stringify(probe).to_utf8_buffer().size() > 262144: break
		nodes.append(flattened[index]); index += 1
	var truncated := index < flattened.size()
	var result := {"nodes": nodes, "truncated": truncated}
	if truncated: result["nextCursor"] = str(index)
	return _success(result)

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
	var applied: Dictionary = _controller().add_node(parent, node, "Add %s" % name, _root())
	if not applied.ok: node.free(); return applied
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
	var result: Dictionary = _controller().duplicate_node(source, parent, int(params.get("flags", 15)), String(params.get("name", "")), "Duplicate %s" % source.name, _root())
	if not result.ok: return result
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
