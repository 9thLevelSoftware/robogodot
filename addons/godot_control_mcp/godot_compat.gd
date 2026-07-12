@tool
extends RefCounted

static var _known_unsaved := false

static func class_names() -> Array[String]:
	var names: Array[String] = []
	for value in ClassDB.get_class_list():
		names.append(String(value))
	names.sort()
	return names

static func class_exists(target_class: String) -> bool:
	return ClassDB.class_exists(target_class)

static func parent_class(target_class: String) -> String:
	return String(ClassDB.get_parent_class(target_class))

static func class_methods(target_class: String) -> Array[Dictionary]:
	return ClassDB.class_get_method_list(target_class, true)

static func class_properties(target_class: String) -> Array[Dictionary]:
	return ClassDB.class_get_property_list(target_class, true)

static func class_signals(target_class: String) -> Array[Dictionary]:
	return ClassDB.class_get_signal_list(target_class, true)

static func class_enums(target_class: String) -> PackedStringArray:
	return ClassDB.class_get_enum_list(target_class, true)

static func enum_constants(target_class: String, enum_name: String) -> PackedStringArray:
	return ClassDB.class_get_enum_constants(target_class, enum_name, true)

static func class_constants(target_class: String) -> PackedStringArray:
	return ClassDB.class_get_integer_constant_list(target_class, true)

static func constant_value(target_class: String, constant_name: String) -> int:
	return ClassDB.class_get_integer_constant(target_class, constant_name)

static func variant_type_name(type_id: int) -> String:
	return type_string(type_id)

static func editor_undo_redo() -> EditorUndoRedoManager:
	return EditorInterface.get_editor_undo_redo()

static func edited_scene_root() -> Node:
	return EditorInterface.get_edited_scene_root()

static func current_scene_path() -> String:
	var current := edited_scene_root()
	var roots: Array = EditorInterface.call("get_open_scene_roots") if EditorInterface.has_method("get_open_scene_roots") else [edited_scene_root()]
	var paths := EditorInterface.get_open_scenes()
	for index in range(mini(roots.size(), paths.size())):
		if roots[index] == current: return String(paths[index])
	return ""

static func scene_is_unsaved() -> bool:
	var path := current_scene_path()
	var unsaved_scenes: PackedStringArray = EditorInterface.call("get_unsaved_scenes") if EditorInterface.has_method("get_unsaved_scenes") else PackedStringArray()
	for unsaved in unsaved_scenes:
		if String(unsaved) == path: return true
	var root := edited_scene_root()
	return root != null and (_known_unsaved or path.is_empty() or (not EditorInterface.has_method("get_unsaved_scenes") and EditorInterface.is_object_edited(root)))

static func mark_scene_unsaved() -> void:
	_known_unsaved = true
	EditorInterface.mark_scene_as_unsaved()

static func scene_open(path: String) -> void:
	_known_unsaved = false
	EditorInterface.open_scene_from_path(path)

static func scene_new(root: Node) -> Error:
	if not EditorInterface.has_method("close_scene") or not EditorInterface.has_method("add_root_node"): return ERR_UNAVAILABLE
	var closed: Error = EditorInterface.call("close_scene")
	if closed != OK and closed != ERR_DOES_NOT_EXIST: return closed
	EditorInterface.call("add_root_node", root)
	_known_unsaved = true
	return OK

static func scene_save(path: String = "") -> Error:
	var error := OK
	if path.is_empty(): error = EditorInterface.save_scene()
	else:
		EditorInterface.save_scene_as(path)
		error = OK if FileAccess.file_exists(path) else ERR_CANT_CREATE
	if error == OK: _known_unsaved = false
	return error

static func canonical_project_path(path: Variant) -> String:
	if not path is String: return ""
	var value := String(path)
	if not value.begins_with("res://") or "\\" in value: return ""
	var parts := value.substr(6).split("/", false)
	if parts.is_empty(): return ""
	for part in parts:
		if part.is_empty() or part == "." or part == "..": return ""
	var localized := ProjectSettings.localize_path(ProjectSettings.globalize_path(value))
	return value if localized == value else ""

static func undo_history_version(undo: EditorUndoRedoManager, target: Object) -> int:
	var history_id := undo.get_object_history_id(target)
	return undo.get_history_undo_redo(history_id).get_version()

static func undo_history_undo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).undo()

static func undo_history_redo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).redo()
