@tool
extends RefCounted

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

static func undo_history_version(undo: EditorUndoRedoManager, target: Object) -> int:
	var history_id := undo.get_object_history_id(target)
	return undo.get_history_undo_redo(history_id).get_version()

static func undo_history_undo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).undo()

static func undo_history_redo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).redo()
