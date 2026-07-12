extends SceneTree

const Handles = preload("res://addons/godot_control_mcp/resource_handles.gd")
const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
const Controller = preload("res://addons/godot_control_mcp/edit_controller.gd")
const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
const Exact = preload("res://addons/godot_control_mcp/exact_variant.gd")
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
	var collision_bytes := PackedByteArray(); collision_bytes.resize(16); collision_bytes.fill(7)
	var collision_state := {"calls": 0}
	var collision_source := func(_size: int) -> PackedByteArray: collision_state.calls += 1; return collision_bytes
	var collision_one := Handles.create(Resource.new(), collision_source)
	var collision_two := Handles.create(Resource.new(), collision_source)
	_check(not collision_one.is_empty() and collision_two.is_empty() and collision_state.calls == 17, "handle collision retries exactly 16 times and exhaust safely")
	Handles.clear()
	_check(Exact.supported({"nested": [Vector2(1, 2), NodePath("a/b"), Color(1, 0, 0, 1)]}), "deep typed supported Variant is accepted")
	_check(Exact.equal({"a": [1, Rect2(1, 2, 3, 4)]}, {"a": [1, Rect2(1, 2, 3, 4)]}), "deep exact comparator matches nested typed values")
	_check(Exact.equal(-0.0, 0.0), "exact comparator follows Godot's normalized negative-zero Variant semantics")
	_check(not Exact.supported(NAN) and not Exact.supported(RefCounted.new()), "NaN and Object are unsupported")

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
	var read_only := Edit.resource_create({"class": "ImageTexture", "properties": {"width": 3}})
	_check(not read_only.ok, "read-only resource property rejects before handle allocation")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(target))

	var undo := Compat.editor_undo_redo()
	var controller := Controller.new(undo)
	var existing_key := "phase3/existing_setting"
	ProjectSettings.set_setting(existing_key, {"nested": [1, "old"]}); Compat.project_settings_save()
	var changed := controller.set_project_setting(existing_key, {"nested": [2, "new"]}, "Set phase3 existing")
	_check(changed.ok and ProjectSettings.get_setting(existing_key) == {"nested": [2, "new"]}, "existing setting applies exactly")
	var persisted_do := ConfigFile.new(); _check(persisted_do.load(project_file_path) == OK and persisted_do.get_value("phase3", "existing_setting") == {"nested": [2, "new"]}, "do value is persisted on disk")
	controller.undo()
	_check(ProjectSettings.has_setting(existing_key) and ProjectSettings.get_setting(existing_key) == {"nested": [1, "old"]}, "undo restores exact prior value")
	var persisted_undo := ConfigFile.new(); _check(persisted_undo.load(project_file_path) == OK and persisted_undo.get_value("phase3", "existing_setting") == {"nested": [1, "old"]}, "undo value is persisted on disk")
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
	_check(not rejected.ok and "godot_script_run" in rejected.hint, "unsupported restoration fixture rejects with Tier B guidance")
	_check(Compat.undo_history_version(undo, ProjectSettings) == version_before, "rejection does not change history")
	var null_rejected := controller.set_project_setting("phase3/null_setting", null, "Reject null")
	_check(not null_rejected.ok and "godot_script_run" in null_rejected.hint, "ambiguous present-null setting rejects with guidance")

	var rollback_key := "phase3/rollback_setting"
	ProjectSettings.set_setting(rollback_key, "old")
	var save_state := {"calls": 0}
	var fail_forward := func() -> Error:
		save_state.calls += 1
		return ERR_CANT_CREATE if save_state.calls == 1 else OK
	var rollback_controller := Controller.new(undo, fail_forward)
	var rollback_result := rollback_controller.set_project_setting(rollback_key, "new", "Rollback failed save")
	_check(not rollback_result.ok and ProjectSettings.get_setting(rollback_key) == "old", "failed forward persistence recovers exact prior in-memory state")
	var always_fail := func() -> Error: return ERR_CANT_CREATE
	var blocked_controller := Controller.new(undo, always_fail)
	var blocked_result := blocked_controller.set_project_setting(rollback_key, "new", "Fail-safe recovery")
	_check(not blocked_result.ok and blocked_result.has("recovery"), "unprovable rollback returns explicit recovery data")
	_check(not blocked_controller.set_project_setting("phase3/blocked", 1, "Blocked").ok, "fail-safe prevents further setting mutations")
	var excessive_descriptors: Array[Dictionary] = []
	excessive_descriptors.resize(20001)
	var capped := Edit.project_setting_list_from_descriptors(excessive_descriptors, {})
	_check(not capped.ok and "20000" in capped.hint, "project setting descriptor scan fails at explicit ceiling")

	for key in [existing_key, absent_key, unsupported_key, rollback_key, "phase3/null_setting", "phase3/blocked"]: ProjectSettings.set_setting(key, null)
	Compat.project_settings_save()
	var project_file := FileAccess.open(project_file_path, FileAccess.WRITE)
	if project_file != null: project_file.store_string(original_project_file)
	else: failures.append("fixture project.godot could not be restored")
	if failures.is_empty(): print("PASS phase 3 resource project")
	else:
		for failure in failures: push_error(failure)
	quit(failures.size())
