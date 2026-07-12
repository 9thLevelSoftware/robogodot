@tool
extends RefCounted

const TypeParse = preload("../util/type_parse.gd")
const EditController = preload("../edit_controller.gd")
const Compat = preload("../godot_compat.gd")
const ResourceHandles = preload("../resource_handles.gd")
const Exact = preload("../exact_variant.gd")
static var _last_tree_visit_count := 0
static var _last_tree_child_reference_count := 0
const MAX_TREE_CHILD_PATHS := 64

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
	var dirty := Compat.scene_dirty_state()
	return _success({"path": Compat.current_scene_path(), "unsaved": dirty.state != "clean", "state": dirty.state, "reason": dirty.reason})

static func resource_load(params: Dictionary) -> Dictionary:
	var path := Compat.canonical_project_path(params.get("path"))
	if path.is_empty() or not FileAccess.file_exists(path): return _failure("Provide an existing canonical res:// resource path.")
	var resource := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not resource is Resource: return _failure("The path is not a loadable Resource.")
	var handle := ResourceHandles.create(resource)
	if handle.is_empty(): return _failure("A secure session handle could not be generated.")
	return _success({"handle": handle, "class": resource.get_class(), "path": path})

static func resource_create(params: Dictionary) -> Dictionary:
	var requested_class = params.get("class")
	if not requested_class is String or not ClassDB.class_exists(requested_class) or not ClassDB.is_parent_class(requested_class, "Resource") or not ClassDB.can_instantiate(requested_class):
		return _failure("Provide an instantiable ClassDB Resource class.")
	var resource = ClassDB.instantiate(requested_class)
	if not resource is Resource: return _failure("The requested class did not instantiate as a Resource.")
	var properties = params.get("properties", {})
	if not properties is Dictionary: return _failure("Resource properties must be a map.")
	for property in properties:
		if not property is String or property in ["__proto__", "prototype", "constructor"]: return _failure("Resource properties must use safe own-property names.")
		var descriptor := _object_property(resource, StringName(property))
		if descriptor.is_empty(): return _failure("Unknown or read-only property '%s'." % property)
		var parsed := TypeParse.parse_variant_literal(properties[property])
		if not parsed.ok or not _value_matches(parsed.value, descriptor): return _failure(parsed.get("error", "Property value has the wrong type."))
		resource.set(property, parsed.value)
		if not Exact.equal(resource.get(property), parsed.value): return _failure("Property '%s' was coerced and could not be set exactly." % property)
	var handle := ResourceHandles.create(resource)
	if handle.is_empty(): return _failure("A secure session handle could not be generated.")
	return _success({"handle": handle, "class": resource.get_class(), "path": ""})

static func resource_save(params: Dictionary) -> Dictionary:
	var resource = ResourceHandles.new().get(params.get("handle"))
	if not resource is Resource: resource = null
	var path := Compat.canonical_project_path(params.get("path"))
	if resource == null: return _failure("Provide a live resource handle from this plugin session.")
	if path.is_empty(): return _failure("Provide a canonical res:// save path.")
	if FileAccess.file_exists(path) and not bool(params.get("overwrite", false)): return _failure("The target exists; set overwrite true to replace it.")
	var error := ResourceSaver.save(resource, path)
	if error != OK or not FileAccess.file_exists(path): return _failure("Godot could not persist the Resource (error %d)." % error)
	return _success({"handle": params.handle, "class": resource.get_class(), "path": path})

static func project_setting_get(params: Dictionary) -> Dictionary:
	var key = params.get("key")
	if not _valid_setting_key(key): return _failure("Provide a safe bounded project-setting key.")
	var result := {"key": key, "exists": ProjectSettings.has_setting(key)}
	if result.exists: result.value = TypeParse.serialize_variant(ProjectSettings.get_setting(key))
	return _success(result)

static func project_setting_set(params: Dictionary) -> Dictionary:
	var key = params.get("key")
	if not _valid_setting_key(key): return _failure("Provide a safe bounded project-setting key.")
	var parsed := TypeParse.parse_variant_literal(params.get("value"))
	if not parsed.ok: return _failure(parsed.error)
	var result: Dictionary = _controller().set_project_setting(key, parsed.value, "Set project setting %s" % key)
	if not result.ok: return result
	var output := {"key": key, "beforeExists": result.before_exists, "after": TypeParse.serialize_variant(ProjectSettings.get_setting(key))}
	if result.before_exists: output.before = TypeParse.serialize_variant(result.before)
	return _success(output)

static func project_setting_list(params: Dictionary) -> Dictionary:
	return project_setting_list_from_descriptors(ProjectSettings.get_property_list(), params)

static func project_setting_list_from_descriptors(descriptors: Array, params: Dictionary) -> Dictionary:
	var prefix = params.get("prefix", "")
	if not prefix is String or String(prefix).to_utf8_buffer().size() > 1024: return _failure("Prefix must be a bounded string.")
	var cursor_text := String(params.get("cursor", "0")); var limit := clampi(int(params.get("limit", 100)), 1, 500)
	if not cursor_text.is_valid_int() or str(cursor_text.to_int()) != cursor_text or cursor_text.to_int() < 0 or cursor_text.length() > 10: return _failure("Cursor must be canonical non-negative decimal.")
	var keys: Array[String] = []
	if descriptors.size() > 20000: return _failure("Project settings exceed the explicit 20000-descriptor scan ceiling; narrow the project or use Tier B inspection.")
	for descriptor in descriptors:
		var key := String(descriptor.name)
		if ProjectSettings.has_setting(key) and key.begins_with(prefix): keys.append(key)
	keys.sort()
	var offset := cursor_text.to_int()
	if offset > 100000: return _failure("Cursor exceeds bounded skip limit.")
	var settings: Array[Dictionary] = []
	for index in range(offset, mini(keys.size(), offset + limit)):
		settings.append({"key": keys[index], "value": TypeParse.serialize_variant(ProjectSettings.get_setting(keys[index]))})
	var next := offset + settings.size(); var output := {"settings": settings, "truncated": next < keys.size()}
	if output.truncated: output.nextCursor = str(next)
	if JSON.stringify(output).to_utf8_buffer().size() > 261632: return _failure("Setting page exceeds the safe response envelope; request a smaller limit.")
	return _success(output)

static func _valid_setting_key(value: Variant) -> bool:
	if not value is String: return false
	var key := String(value)
	return not key.is_empty() and key.to_utf8_buffer().size() <= 1024 and key not in ["__proto__", "prototype", "constructor"] and not key.begins_with("/") and not key.ends_with("/") and not "//" in key

static func scene_open(params: Dictionary) -> Dictionary:
	var path := Compat.canonical_project_path(params.get("path"))
	if path.is_empty() or not FileAccess.file_exists(path): return _failure("Provide an existing canonical res:// scene path.")
	if not ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) is PackedScene: return _failure("The requested path is not a loadable PackedScene.")
	var dirty := Compat.scene_dirty_state()
	if dirty.state != "clean" and not bool(params.get("discardUnsaved", false)): return _failure("Current scene state is %s (%s); set discardUnsaved true to replace it." % [dirty.state, dirty.reason])
	Compat.scene_open(path)
	if not Compat.scene_open_completed(path): return _failure("Godot did not complete opening the requested scene; it may be invalid or corrupt.")
	return _success({"path": path, "unsaved": false, "state": "clean", "reason": "opened_scene"})

static func scene_new(params: Dictionary) -> Dictionary:
	var dirty := Compat.scene_dirty_state()
	if dirty.state != "clean" and not bool(params.get("discardUnsaved", false)): return _failure("Current scene state is %s (%s); set discardUnsaved true to replace it." % [dirty.state, dirty.reason])
	var type = params.get("rootType", "Node"); var name = params.get("rootName", "Root")
	if not type is String or not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, "Node") or not name is String or name.is_empty() or name.validate_node_name() != name:
		return _failure("Provide a valid Node root type and root name.")
	var root: Node = ClassDB.instantiate(type); root.name = name
	var error := Compat.scene_new(root)
	if error != OK: root.free(); return _failure("Godot could not create the scene with the public editor lifecycle API (error %d)." % error)
	return _success({"path": "", "unsaved": true, "state": "dirty", "reason": "new_scene"})

static func scene_save(params: Dictionary) -> Dictionary:
	if _root() == null: return _failure("There is no edited scene to save.")
	var current := Compat.current_scene_path(); var requested = params.get("path", current)
	var path := Compat.canonical_project_path(requested)
	if path.is_empty(): return _failure("Provide a canonical res:// save path.")
	if FileAccess.file_exists(path) and path != current and not bool(params.get("overwrite", false)):
		return _failure("The different target path already exists; set overwrite true to replace it.")
	var error := Compat.scene_save("" if path == current else path)
	if error != OK: return _failure("Godot could not save the scene (error %d)." % error)
	return _success({"path": path, "unsaved": false, "state": "clean", "reason": "verified_save"})

static func scene_tree(params: Dictionary) -> Dictionary:
	var root := _root() if not params.has("root") else _node(params.get("root"))
	if root == null: return _failure("Provide a live root in the edited scene.")
	var max_depth := clampi(int(params.get("maxDepth", 8)), 1, 32)
	var limit := clampi(int(params.get("limit", 100)), 1, 500)
	var cursor_text := String(params.get("cursor", "0"))
	if not cursor_text.is_valid_int() or str(cursor_text.to_int()) != cursor_text or cursor_text.to_int() < 0 or cursor_text.length() > 10: return _failure("Cursor must be a canonical non-negative decimal traversal offset.")
	var offset := cursor_text.to_int()
	if offset > 100000: return _failure("Cursor exceeds the bounded traversal skip limit.")
	var stack: Array[Dictionary] = [{"node": root, "depth": 0, "next_child_index": -1}]
	var nodes: Array[Dictionary] = []; var visited := 0; var byte_limit := 261632
	_last_tree_visit_count = 0
	_last_tree_child_reference_count = 0
	while not stack.is_empty() and nodes.size() < limit:
		var entry := stack.back() as Dictionary; var node := entry.node as Node; var depth := int(entry.depth)
		_last_tree_visit_count += 1
		_advance_tree_stack(stack, max_depth)
		if visited < offset: visited += 1; continue
		var child_count := node.get_child_count(); var child_paths: Array[String] = []
		if depth < max_depth:
			for child_index in range(mini(child_count, MAX_TREE_CHILD_PATHS)):
				child_paths.append(_path(node.get_child(child_index))); _last_tree_child_reference_count += 1
		var record := {"name": String(node.name), "class": node.get_class(), "path": _path(node), "depth": depth, "children": child_paths, "childCount": child_count, "childrenTruncated": child_paths.size() < child_count}
		if node != root: record["parent"] = _path(node.get_parent())
		var candidate: Array[Dictionary] = nodes.duplicate(); candidate.append(record)
		var probe := {"nodes": candidate, "truncated": true, "nextCursor": str(offset + candidate.size())}
		if JSON.stringify(probe).to_utf8_buffer().size() > byte_limit:
			if nodes.is_empty(): return _failure("A single tree record exceeds the safe response envelope budget.")
			break
		nodes.append(record); visited += 1
	var index := offset + nodes.size(); var truncated := not stack.is_empty()
	var result := {"nodes": nodes, "truncated": truncated}
	if truncated: result["nextCursor"] = str(index)
	return _success(result)

static func _advance_tree_stack(stack: Array[Dictionary], max_depth: int) -> void:
	while not stack.is_empty():
		var frame := stack.back() as Dictionary; var node := frame.node as Node; var depth := int(frame.depth)
		var next_index := int(frame.next_child_index) + 1
		frame.next_child_index = next_index; stack[stack.size() - 1] = frame
		if depth < max_depth and next_index < node.get_child_count():
			stack.append({"node": node.get_child(next_index), "depth": depth + 1, "next_child_index": -1})
			return
		stack.pop_back()

static func scene_tree_last_visit_count() -> int:
	return _last_tree_visit_count

static func scene_tree_last_child_reference_count() -> int:
	return _last_tree_child_reference_count

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

static func node_instance(params: Dictionary) -> Dictionary:
	var parent := _node(params.get("parent")); var path := Compat.canonical_project_path(params.get("scenePath"))
	if parent == null or path.is_empty() or not FileAccess.file_exists(path): return _failure("Provide a live parent and existing canonical res:// scene path.")
	var resource := ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not resource is PackedScene: return _failure("The resource is not a PackedScene.")
	var instance := (resource as PackedScene).instantiate()
	if instance == null: return _failure("The PackedScene could not be instantiated.")
	if params.has("name"):
		var requested = params.get("name")
		if not requested is String or requested.is_empty() or requested.validate_node_name() != requested: instance.free(); return _failure("Provide a valid instance name.")
		instance.name = requested
	var result: Dictionary = _controller().instance_scene(parent, instance, _root(), "Instance %s" % path)
	if not result.ok: instance.free(); return result
	return _success({"path": _path(instance), "type": instance.get_class(), "scenePath": path})

static func signal_list(params: Dictionary) -> Dictionary:
	var source := _node(params.get("path")); if source == null: return _failure("Provide a live source node.")
	var cursor_text := String(params.get("cursor", "0")); var limit := clampi(int(params.get("limit", 100)), 1, 500)
	if not cursor_text.is_valid_int() or str(cursor_text.to_int()) != cursor_text or cursor_text.to_int() < 0 or cursor_text.length() > 10: return _failure("Cursor must be canonical non-negative decimal.")
	var descriptors := source.get_signal_list(); descriptors.sort_custom(func(a, b): return String(a.name) < String(b.name))
	var offset := cursor_text.to_int(); if offset > 100000: return _failure("Cursor exceeds bounded skip limit.")
	var output: Array[Dictionary] = []
	for index in range(offset, mini(descriptors.size(), offset + limit)):
		var descriptor := descriptors[index] as Dictionary; var arguments: Array[Dictionary] = []
		for argument in descriptor.get("args", []).slice(0, 64): arguments.append({"name": String(argument.name), "type": int(argument.type)})
		var connections: Array[Dictionary] = []
		for entry in source.get_signal_connection_list(StringName(descriptor.name)):
			var cb := entry.callable as Callable; var target = cb.get_object()
			if target is Node and _root() != null and (target == _root() or _root().is_ancestor_of(target)): connections.append({"callable": {"target": _path(target), "method": String(cb.get_method())}, "flags": int(entry.flags)})
		connections.sort_custom(func(a, b):
			var a_key := "%s\n%s\n%010d" % [a.callable.target, a.callable.method, a.flags]
			var b_key := "%s\n%s\n%010d" % [b.callable.target, b.callable.method, b.flags]
			return a_key < b_key)
		var connection_count := connections.size()
		if connections.size() > 256: connections.resize(256)
		output.append({"name": String(descriptor.name), "arguments": arguments, "connections": connections, "connectionCount": connection_count, "connectionsTruncated": connection_count > connections.size()})
	var next := offset + output.size(); var response := {"signals": output, "truncated": next < descriptors.size()}
	if response.truncated: response.nextCursor = str(next)
	if JSON.stringify(response).to_utf8_buffer().size() > 261632: return _failure("Signal page exceeds safe response envelope; request a smaller limit.")
	return _success(response)

static func signal_connect(params: Dictionary) -> Dictionary: return _signal_mutation(params, true)
static func signal_disconnect(params: Dictionary) -> Dictionary: return _signal_mutation(params, false)
static func _signal_mutation(params: Dictionary, connecting: bool) -> Dictionary:
	var source := _node(params.get("source")); var signal_name = params.get("signal"); var callable_data = params.get("callable")
	if source == null or not signal_name is String or not callable_data is Dictionary: return _failure("Provide a live source, signal, and callable.")
	var target := _node(callable_data.get("target")); var method = callable_data.get("method")
	if target == null or not method is String or not source.has_signal(signal_name) or not target.has_method(method): return _failure("Signal and callable must resolve live.")
	var cb := Callable(target, StringName(method)); var raw_flags = params.get("flags", 0); var flags := int(raw_flags)
	var flags_are_integral: bool = raw_flags is int or (raw_flags is float and is_finite(raw_flags) and raw_flags == float(flags))
	if connecting and (not flags_are_integral or flags < 0 or flags > 15): return _failure("Connect flags must be an integer using only the Godot ConnectFlags mask 0..15.")
	var result: Dictionary = _controller().connect_signal(source, StringName(signal_name), cb, flags, "Connect %s" % signal_name) if connecting else _controller().disconnect_signal(source, StringName(signal_name), cb, "Disconnect %s" % signal_name)
	if not result.ok: return result
	return _success({"source": _path(source), "signal": signal_name, "callable": {"target": _path(target), "method": method}, "flags": flags if connecting else int(result.flags)})

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
	return _object_property(node, name)
static func _object_property(object: Object, name: StringName) -> Dictionary:
	for entry in object.get_property_list():
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
