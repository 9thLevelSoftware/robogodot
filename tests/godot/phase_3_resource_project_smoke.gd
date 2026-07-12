extends SceneTree

const Handles = preload("res://addons/godot_control_mcp/resource_handles.gd")
const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
const Controller = preload("res://addons/godot_control_mcp/edit_controller.gd")
const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
var failures: Array[String] = []

func _check(condition: bool, message: String) -> void:
	if not condition: failures.append(message)

func _initialize() -> void:
	var project_file_path := ProjectSettings.globalize_path("res://project.godot")
	var original_project_file := FileAccess.get_file_as_string(project_file_path)
	var resource := Resource.new()
	var handles := Handles.new()
	var handle: String = Handles.create(resource)
	_check(handle.begins_with("res_") and handle.length() == 26, "handle has opaque 128-bit base64url shape")
	_check(handles.get(handle) == resource, "handle resolves its Resource")
	_check(handles.get("res_0123456789abcdefghijkl") == null, "forged handle is rejected")
	Handles.clear()
	_check(handles.get(handle) == null, "session reset clears handles")

	var created := Edit.resource_create({"class": "Gradient", "properties": {}})
	_check(created.ok, "allowed Resource class creates")
	var created_handle: String = created.result.handle if created.ok else ""
	var target := "res://phase3_resource_project.tres"
	var existing := Resource.new(); ResourceSaver.save(existing, target)
	_check(not Edit.resource_save({"handle": created_handle, "path": target}).ok, "existing save requires overwrite confirmation")
	_check(not Edit.resource_save({"handle": created_handle, "path": "res://folder/../escape.tres", "overwrite": true}).ok, "path escape is rejected")
	var saved := Edit.resource_save({"handle": created_handle, "path": target, "overwrite": true})
	_check(saved.ok and saved.result.path == target, "confirmed resource save succeeds canonically")
	var loaded := Edit.resource_load({"path": target})
	_check(loaded.ok and loaded.result.handle != created_handle, "resource load returns a fresh opaque handle")
	_check(not Edit.resource_save({"handle": "res_0123456789abcdefghijkl", "path": target, "overwrite": true}).ok, "command rejects forged handle")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(target))

	var undo := Compat.editor_undo_redo()
	var controller := Controller.new(undo)
	var existing_key := "phase3/existing_setting"
	ProjectSettings.set_setting(existing_key, {"nested": [1, "old"]}); Compat.project_settings_save()
	var changed := controller.set_project_setting(existing_key, {"nested": [2, "new"]}, "Set phase3 existing")
	_check(changed.ok and ProjectSettings.get_setting(existing_key) == {"nested": [2, "new"]}, "existing setting applies exactly")
	controller.undo()
	_check(ProjectSettings.has_setting(existing_key) and ProjectSettings.get_setting(existing_key) == {"nested": [1, "old"]}, "undo restores exact prior value")
	controller.redo()
	_check(ProjectSettings.get_setting(existing_key) == {"nested": [2, "new"]}, "redo restores exact new value")

	var absent_key := "phase3/absent_setting"
	ProjectSettings.set_setting(absent_key, null); Compat.project_settings_save()
	var added := controller.set_project_setting(absent_key, 42, "Set phase3 absent")
	_check(added.ok and ProjectSettings.has_setting(absent_key), "absent setting is created")
	controller.undo()
	_check(not ProjectSettings.has_setting(absent_key), "undo restores exact absence")
	controller.redo()
	_check(ProjectSettings.has_setting(absent_key) and ProjectSettings.get_setting(absent_key) == 42, "redo recreates setting")

	var unsupported_key := "phase3/unsupported_setting"
	ProjectSettings.set_setting(unsupported_key, RefCounted.new())
	var version_before := Compat.undo_history_version(undo, ProjectSettings)
	var rejected := controller.set_project_setting(unsupported_key, "replacement", "Reject unsupported")
	_check(not rejected.ok, "unsupported restoration fixture is rejected")
	_check(Compat.undo_history_version(undo, ProjectSettings) == version_before, "rejection does not change history")

	for key in [existing_key, absent_key, unsupported_key]: ProjectSettings.set_setting(key, null)
	Compat.project_settings_save()
	var project_file := FileAccess.open(project_file_path, FileAccess.WRITE)
	if project_file != null: project_file.store_string(original_project_file)
	else: failures.append("fixture project.godot could not be restored")
	if failures.is_empty(): print("PASS phase 3 resource project")
	else:
		for failure in failures: push_error(failure)
	quit(failures.size())
