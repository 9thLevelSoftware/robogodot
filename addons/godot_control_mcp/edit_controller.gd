@tool
extends RefCounted

const Compat = preload("godot_compat.gd")
var _undo: EditorUndoRedoManager
var _last_history_target: Object

func _init(undo: EditorUndoRedoManager) -> void:
	_undo = undo

func add_node(parent: Node, node: Node, action_name: String) -> Dictionary:
	if not is_instance_valid(parent) or not is_instance_valid(node) or node.get_parent() != null:
		return _failure("Parent and detached node are required.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, parent)
	_undo.add_do_method(parent, "add_child", node, true)
	_undo.add_do_reference(node)
	_undo.add_undo_method(parent, "remove_child", node)
	_undo.commit_action()
	_last_history_target = parent
	return {"ok": true}

func rename_node(node: Node, new_name: String, action_name: String) -> Dictionary:
	if not is_instance_valid(node) or new_name.is_empty() or new_name.validate_node_name() != new_name:
		return _failure("A valid node and node name are required.")
	var old_name := node.name
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, node)
	_undo.add_do_property(node, "name", new_name)
	_undo.add_undo_property(node, "name", old_name)
	_undo.commit_action()
	_last_history_target = node
	return {"ok": true}

func set_property(target: Object, property: StringName, value: Variant, action_name: String) -> Dictionary:
	if not is_instance_valid(target) or not _is_writable_property(target, property):
		return _failure("A valid target and property are required.")
	var old_value: Variant = target.get(property)
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, target)
	_undo.add_do_property(target, property, value)
	_undo.add_undo_property(target, property, old_value)
	_undo.commit_action()
	_last_history_target = target
	return {"ok": true}

func undo() -> void:
	Compat.undo_history_undo(_undo, _last_history_target)

func redo() -> void:
	Compat.undo_history_redo(_undo, _last_history_target)

func _is_writable_property(target: Object, property: StringName) -> bool:
	for entry in target.get_property_list():
		if StringName(entry.name) == property:
			var usage := int(entry.usage)
			var persisted_or_editor := (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)) != 0
			return persisted_or_editor and (usage & PROPERTY_USAGE_READ_ONLY) == 0
	return false

func _failure(hint: String) -> Dictionary:
	return {"ok": false, "hint": hint}
