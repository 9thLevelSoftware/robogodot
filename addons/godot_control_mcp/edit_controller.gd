@tool
extends RefCounted

const Compat = preload("godot_compat.gd")
const Exact = preload("exact_variant.gd")
var _undo: EditorUndoRedoManager
var _last_history_target: Object
var _save_project_settings: Callable
var _project_settings_blocked := false

func _init(undo: EditorUndoRedoManager, save_project_settings: Callable = Callable()) -> void:
	_undo = undo
	_save_project_settings = save_project_settings if save_project_settings.is_valid() else Compat.project_settings_save

func add_node(parent: Node, node: Node, action_name: String, persistent_owner: Node = null) -> Dictionary:
	if not is_instance_valid(parent) or not is_instance_valid(node) or node.get_parent() != null:
		return _failure("Parent and detached node are required.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, parent)
	_undo.add_do_method(parent, "add_child", node, true)
	if is_instance_valid(persistent_owner): _add_do_owner_recursive(node, persistent_owner)
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

func delete_node(node: Node, action_name: String) -> Dictionary:
	if not is_instance_valid(node) or node.get_parent() == null:
		return _failure("An attached node is required.")
	var parent := node.get_parent()
	var index := node.get_index()
	var owners: Array[Dictionary] = []
	_snapshot_owners(node, owners)
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, parent)
	_undo.add_do_method(parent, "remove_child", node)
	_undo.add_undo_method(parent, "add_child", node, true)
	_undo.add_undo_method(parent, "move_child", node, index)
	for entry in owners: _undo.add_undo_property(entry.node, "owner", entry.owner)
	_undo.add_undo_reference(node)
	_undo.commit_action()
	_last_history_target = parent
	return {"ok": true}

func reparent_node(node: Node, parent: Node, index: int, action_name: String) -> Dictionary:
	if not is_instance_valid(node) or not is_instance_valid(parent) or node.get_parent() == null or node == parent or node.is_ancestor_of(parent):
		return _failure("Valid non-cyclic node and parent are required.")
	var old_parent := node.get_parent()
	var old_index := node.get_index()
	var old_owner := node.owner
	var old_transform: Variant = node.global_transform if node is Node2D or node is Node3D else null
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, node)
	_undo.add_do_method(node, "reparent", parent, true)
	if index >= 0: _undo.add_do_method(parent, "move_child", node, mini(index, parent.get_child_count()))
	_undo.add_do_property(node, "owner", old_owner)
	_undo.add_undo_method(node, "reparent", old_parent, true)
	_undo.add_undo_method(old_parent, "move_child", node, old_index)
	_undo.add_undo_property(node, "owner", old_owner)
	if node is Node2D or node is Node3D:
		_undo.add_undo_property(node, "global_transform", old_transform)
	_undo.commit_action()
	_last_history_target = node
	return {"ok": true}

func duplicate_node(source: Node, parent: Node, duplicate_flags: int, requested_name: String, action_name: String, persistent_owner: Node) -> Dictionary:
	if not is_instance_valid(source) or not is_instance_valid(parent):
		return _failure("Valid source and parent nodes are required.")
	var copy := source.duplicate(duplicate_flags)
	if copy == null: return _failure("Godot could not duplicate the node.")
	if not requested_name.is_empty(): copy.name = requested_name
	var result := add_node(parent, copy, action_name, persistent_owner)
	if result.ok: result.node = copy
	return result

func instance_scene(parent: Node, instance: Node, persistent_owner: Node, action_name: String) -> Dictionary:
	if not is_instance_valid(parent) or not is_instance_valid(instance) or instance.get_parent() != null or instance.scene_file_path.is_empty():
		return _failure("A valid parent and detached PackedScene instance are required.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, parent)
	_undo.add_do_method(parent, "add_child", instance, true)
	if is_instance_valid(persistent_owner): _undo.add_do_property(instance, "owner", persistent_owner)
	_undo.add_do_reference(instance)
	_undo.add_undo_method(parent, "remove_child", instance)
	_undo.commit_action()
	_last_history_target = parent
	return {"ok": true}

func connect_signal(source: Object, signal_name: StringName, callable: Callable, flags: int, action_name: String) -> Dictionary:
	if not _valid_signal_callable(source, signal_name, callable) or source.is_connected(signal_name, callable):
		return _failure("A live signal and unconnected callable are required.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, source)
	_undo.add_do_method(source, "connect", signal_name, callable, flags)
	_undo.add_undo_method(source, "disconnect", signal_name, callable)
	_undo.commit_action()
	_last_history_target = source
	return {"ok": true}

func disconnect_signal(source: Object, signal_name: StringName, callable: Callable, action_name: String) -> Dictionary:
	if not _valid_signal_callable(source, signal_name, callable) or not source.is_connected(signal_name, callable):
		return _failure("A live signal and connected callable are required.")
	var flags := -1
	for entry in source.get_signal_connection_list(signal_name):
		if entry.callable == callable: flags = int(entry.flags); break
	if flags < 0: return _failure("The exact live connection could not be snapshotted.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, source)
	_undo.add_do_method(source, "disconnect", signal_name, callable)
	_undo.add_undo_method(source, "connect", signal_name, callable, flags)
	_undo.commit_action()
	_last_history_target = source
	return {"ok": true, "flags": flags}

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

func set_project_setting(key: String, value: Variant, action_name: String) -> Dictionary:
	if _project_settings_blocked: return _failure("Project-setting mutations are blocked after an unproven recovery; restart the plugin and inspect with godot_script_run.")
	if key.is_empty() or value == null or not Exact.supported(value): return _tier_b_failure("A non-null exactly supported project-setting value is required.")
	var existed := ProjectSettings.has_setting(key)
	var old_value: Variant = ProjectSettings.get_setting(key) if existed else null
	if existed and (old_value == null or not Exact.supported(old_value)): return _tier_b_failure("The previous value cannot be restored exactly.")
	if not _apply_project_setting(key, true, value):
		return _recover_project_setting(key, existed, old_value, value, "The new project setting could not be persisted exactly.")
	if not _apply_project_setting(key, existed, old_value):
		return _recover_project_setting(key, existed, old_value, value, "The previous project setting could not be restored exactly during preflight.")
	_undo.create_action(action_name, UndoRedo.MERGE_DISABLE, ProjectSettings)
	_undo.add_do_method(self, "_apply_project_setting", key, true, value)
	_undo.add_undo_method(self, "_apply_project_setting", key, existed, old_value)
	_undo.add_do_reference(self)
	_undo.commit_action()
	_last_history_target = ProjectSettings
	if not ProjectSettings.has_setting(key) or not Exact.equal(ProjectSettings.get_setting(key), value):
		return _failure("Godot did not retain the exact new project-setting value.")
	return {"ok": true, "before_exists": existed, "before": old_value}

func _apply_project_setting(key: String, should_exist: bool, value: Variant) -> bool:
	ProjectSettings.set_setting(key, value if should_exist else null)
	if _save_project_settings.call() != OK: return false
	if ProjectSettings.has_setting(key) != should_exist: return false
	return not should_exist or Exact.equal(ProjectSettings.get_setting(key), value)

func _recover_project_setting(key: String, existed: bool, old_value: Variant, attempted: Variant, reason: String) -> Dictionary:
	for _attempt in range(3):
		if _apply_project_setting(key, existed, old_value): return _failure(reason + " Exact prior state was recovered.")
	_project_settings_blocked = true
	_undo.create_action("Recover project setting %s" % key, UndoRedo.MERGE_DISABLE, ProjectSettings)
	_undo.add_do_method(self, "_apply_project_setting", key, true, attempted)
	_undo.add_undo_method(self, "_apply_project_setting", key, existed, old_value)
	_undo.add_do_reference(self)
	_undo.commit_action()
	_last_history_target = ProjectSettings
	return {"ok": false, "hint": reason + " Recovery could not be proven; mutations are blocked and a recovery UndoRedo action was retained.", "recovery": {"key": key, "priorExists": existed, "prior": old_value, "attempted": attempted}}

func _tier_b_failure(message: String) -> Dictionary:
	return _failure(message + " Use godot_script_run (Tier B) to inspect or perform this unsupported setting change explicitly.")

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

func _valid_signal_callable(source: Object, signal_name: StringName, callable: Callable) -> bool:
	if not is_instance_valid(source) or not source.has_signal(signal_name) or not callable.is_valid(): return false
	var target := callable.get_object()
	return is_instance_valid(target) and target.has_method(callable.get_method())

func _add_do_owner_recursive(node: Node, owner: Node) -> void:
	_undo.add_do_property(node, "owner", owner)
	for child in node.get_children(): _add_do_owner_recursive(child, owner)

func _snapshot_owners(node: Node, output: Array[Dictionary]) -> void:
	output.append({"node": node, "owner": node.owner})
	for child in node.get_children(): _snapshot_owners(child, output)
