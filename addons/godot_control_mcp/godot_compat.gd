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

static func scene_dirty_state() -> Dictionary:
	var path := current_scene_path()
	var unsaved_scenes: PackedStringArray = EditorInterface.call("get_unsaved_scenes") if EditorInterface.has_method("get_unsaved_scenes") else PackedStringArray()
	for unsaved in unsaved_scenes:
		if String(unsaved) == path: return {"state": "dirty", "reason": "editor_unsaved_scenes"}
	var root := edited_scene_root()
	if root == null: return {"state": "clean", "reason": "no_open_scene"}
	if _known_unsaved: return {"state": "dirty", "reason": "mcp_lifecycle_change"}
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if EditorInterface.is_object_edited(node): return {"state": "dirty", "reason": "edited_object"}
		for child in node.get_children(): stack.append(child)
	if EditorInterface.has_method("get_unsaved_scenes"): return {"state": "clean", "reason": "editor_unsaved_scenes"}
	return {"state": "unknown", "reason": "authoritative_unsaved_api_unavailable"}

static func mark_scene_unsaved() -> void:
	_known_unsaved = true
	EditorInterface.mark_scene_as_unsaved()

static func scene_open(path: String) -> void:
	EditorInterface.open_scene_from_path(path)

static func scene_open_completed(path: String) -> bool:
	var root := edited_scene_root()
	if root != null and canonical_project_path(root.scene_file_path) == path:
		_known_unsaved = false
		return true
	return false

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
		EditorInterface.save_scene_as(path, false)
		var root := edited_scene_root()
		error = OK if root != null and canonical_project_path(root.scene_file_path) == path and ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) is PackedScene else ERR_CANT_CREATE
	if error == OK:
		var saved_root := edited_scene_root(); var saved_path := canonical_project_path(saved_root.scene_file_path) if saved_root != null else ""
		if saved_root == null or saved_path.is_empty() or not ResourceLoader.load(saved_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) is PackedScene: return ERR_CANT_CREATE
		EditorInterface.set_object_edited(saved_root, false)
		if EditorInterface.is_object_edited(saved_root): return ERR_CANT_CREATE
		_known_unsaved = false
	return error

static func canonical_project_path(path: Variant) -> String:
	if not path is String: return ""
	var value := String(path)
	if value.to_utf8_buffer().size() > 1024: return ""
	if not value.begins_with("res://") or "\\" in value: return ""
	var parts := value.substr(6).split("/", false)
	if parts.is_empty(): return ""
	for part in parts:
		if part.is_empty() or part == "." or part == "..": return ""
	var localized := ProjectSettings.localize_path(ProjectSettings.globalize_path(value))
	return value if localized == value else ""

static func canonical_user_root() -> String:
	var value := ProjectSettings.globalize_path("user://").simplify_path()
	return value.trim_suffix("/").trim_suffix("\\")

static func create_runtime_session(session_id: String) -> Dictionary:
	if session_id.length() != 32 or "/" in session_id or "\\" in session_id or "." in session_id: return {"ok":false, "hint":"Invalid runtime session ID."}
	var user_root := canonical_user_root()
	if user_root.is_empty(): return {"ok":false, "hint":"Could not canonicalize user://."}
	var approved_root := user_root.path_join(".mcp").simplify_path()
	var user_directory := DirAccess.open(user_root)
	if user_directory != null and user_directory.is_link(".mcp"): return {"ok":false, "hint":"Runtime storage root may not be a symbolic link."}
	if not DirAccess.dir_exists_absolute(approved_root):
		var root_error := DirAccess.make_dir_recursive_absolute(approved_root)
		if root_error != OK: return {"ok":false, "hint":"Could not create the runtime storage root."}
	var session_root := approved_root.path_join(session_id).simplify_path()
	if not session_root.begins_with(approved_root + "/") and not session_root.begins_with(approved_root + "\\"): return {"ok":false, "hint":"Runtime session escaped approved storage."}
	if DirAccess.dir_exists_absolute(session_root) or FileAccess.file_exists(session_root): return {"ok":false, "hint":"Runtime session already exists."}
	var error := DirAccess.make_dir_absolute(session_root)
	if error != OK: return {"ok":false, "hint":"Could not create the runtime session."}
	return {"ok":true, "user_root":user_root, "session_root":session_root}

static func cleanup_runtime_session(session_id: String) -> Error:
	if session_id.length() != 32 or "/" in session_id or "\\" in session_id or "." in session_id: return ERR_INVALID_PARAMETER
	var session_root := canonical_user_root().path_join(".mcp").path_join(session_id).simplify_path()
	if not DirAccess.dir_exists_absolute(session_root): return OK
	if not _runtime_root_chain_safe(session_id): return ERR_INVALID_DATA
	var directory := DirAccess.open(session_root)
	if directory == null: return DirAccess.get_open_error()
	var entries := directory.get_files()
	var directories := directory.get_directories()
	var config_name := "bridge-config-v1.json"
	if not directories.is_empty() or entries.size() > 1 or entries.size() == 1 and entries[0] != config_name: return ERR_INVALID_DATA
	if entries.size() == 1:
		if directory.is_link(config_name): return ERR_INVALID_DATA
		var config_path := session_root.path_join(config_name)
		var size := FileAccess.get_size(config_path)
		var modified := FileAccess.get_modified_time(config_path)
		if size <= 0 or size > 32768: return ERR_INVALID_DATA
		if not _runtime_root_chain_safe(session_id): return ERR_INVALID_DATA
		var current := DirAccess.open(session_root)
		if current == null or current.is_link(config_name) or not FileAccess.file_exists(config_path) or DirAccess.dir_exists_absolute(config_path): return ERR_INVALID_DATA
		if FileAccess.get_size(config_path) != size or FileAccess.get_modified_time(config_path) != modified: return ERR_INVALID_DATA
		var config_error := DirAccess.remove_absolute(config_path)
		if config_error != OK: return config_error
	if not _runtime_root_chain_safe(session_id): return ERR_INVALID_DATA
	directory = DirAccess.open(session_root)
	if directory == null or not directory.get_files().is_empty() or not directory.get_directories().is_empty(): return ERR_INVALID_DATA
	var session_error := DirAccess.remove_absolute(session_root)
	if session_error != OK: return session_error
	var approved_root := canonical_user_root().path_join(".mcp").simplify_path()
	var approved := DirAccess.open(approved_root)
	if approved != null and approved.get_files().is_empty() and approved.get_directories().is_empty():
		var user := DirAccess.open(canonical_user_root())
		if user == null or user.is_link(".mcp"): return ERR_INVALID_DATA
		return DirAccess.remove_absolute(approved_root)
	return OK

static func _runtime_root_chain_safe(session_id: String) -> bool:
	var user_root := canonical_user_root()
	var user := DirAccess.open(user_root)
	var approved := DirAccess.open(user_root.path_join(".mcp"))
	return user != null and approved != null and not user.is_link(".mcp") and not approved.is_link(session_id)

static func verified_runtime_resources(launcher: String, bridge: String) -> Dictionary:
	if launcher != "res://addons/godot_control_mcp/runtime/runtime_launcher.gd" or bridge != "res://addons/godot_control_mcp/runtime/bridge_manifest.gd": return {"ok":false, "hint":"Runtime resource names are not approved."}
	if not ResourceLoader.exists(launcher, "Script") or not ResourceLoader.load(launcher, "Script", ResourceLoader.CACHE_MODE_IGNORE) is Script: return {"ok":false, "hint":"Runtime launcher resource is unavailable."}
	if not ResourceLoader.exists(bridge, "Script") or not ResourceLoader.load(bridge, "Script", ResourceLoader.CACHE_MODE_IGNORE) is Script: return {"ok":false, "hint":"Runtime bridge manifest resource is unavailable."}
	return {"ok":true, "launcher_path":ProjectSettings.globalize_path(launcher).simplify_path(), "bridge_path":ProjectSettings.globalize_path(bridge).simplify_path()}

static func project_settings_save() -> Error:
	return ProjectSettings.save()

static func undo_history_version(undo: EditorUndoRedoManager, target: Object) -> int:
	var history_id := undo.get_object_history_id(target)
	return undo.get_history_undo_redo(history_id).get_version()

static func undo_history_has_undo(undo: EditorUndoRedoManager, target: Object) -> bool:
	var history_id := undo.get_object_history_id(target)
	return undo.get_history_undo_redo(history_id).has_undo()

static func undo_history_undo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).undo()

static func undo_history_redo(undo: EditorUndoRedoManager, target: Object) -> void:
	var history_id := undo.get_object_history_id(target)
	undo.get_history_undo_redo(history_id).redo()
