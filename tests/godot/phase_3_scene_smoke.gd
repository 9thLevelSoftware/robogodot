extends SceneTree

const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
var failures: Array[String] = []

func _initialize() -> void: call_deferred("_run")
func _check(value: bool, message: String) -> void:
	if not value: failures.append(message); push_error(message)
func _frames(count: int = 20) -> void:
	for ignored in range(count): await process_frame

func _run() -> void:
	Compat.scene_open("res://phase3/node_fixture.tscn")
	await _frames()
	var root := Compat.edited_scene_root()
	_check(root != null, "fixture opens")
	var current: Dictionary = Edit.scene_current({})
	_check(current.ok and current.result.path == "res://phase3/node_fixture.tscn" and not current.result.unsaved, "current scene")
	var tree: Dictionary = Edit.scene_tree({"maxDepth": 1, "limit": 2})
	_check(tree.ok and tree.result.nodes.size() == 2 and tree.result.nodes[0].name == "Main" and tree.result.nodes[1].name == "A" and tree.result.truncated, "stable bounded tree page")
	var next: Dictionary = Edit.scene_tree({"maxDepth": 1, "limit": 2, "cursor": tree.result.nextCursor})
	_check(next.ok and next.result.nodes.size() == 1 and next.result.nodes[0].name == "B" and not next.result.truncated, "cursor continues deterministic traversal")
	EditorInterface.set_object_edited(root, true)
	var refused: Dictionary = Edit.scene_new({"rootType": "Node2D", "rootName": "Fresh"})
	_check(not refused.ok and Compat.edited_scene_root() == root, "new rejects unconfirmed discard")
	var created: Dictionary = Edit.scene_new({"rootType": "Node2D", "rootName": "Fresh", "discardUnsaved": true})
	await _frames()
	_check(created.ok and Compat.edited_scene_root().name == "Fresh", "new scene")
	var fresh_root := Compat.edited_scene_root()
	var fresh_history := Compat.undo_history_version(Compat.editor_undo_redo(), fresh_root)
	var saved: Dictionary = Edit.scene_save({"path": "res://phase3/generated_scene.tscn"})
	await _frames()
	_check(saved.ok and FileAccess.file_exists("res://phase3/generated_scene.tscn"), "save new path")
	_check(Compat.undo_history_version(Compat.editor_undo_redo(), fresh_root) == fresh_history, "save does not add UndoRedo history")
	var denied_overwrite: Dictionary = Edit.scene_save({"path": "res://phase3/node_fixture.tscn"})
	_check(not denied_overwrite.ok, "existing different path requires overwrite")
	var overwritten: Dictionary = Edit.scene_save({"path": "res://phase3/generated_scene.tscn", "overwrite": true})
	_check(overwritten.ok, "same path save succeeds")
	var reopened: Dictionary = Edit.scene_open({"path": "res://phase3/generated_scene.tscn", "discardUnsaved": true})
	await _frames()
	_check(reopened.ok and Compat.edited_scene_root().name == "Fresh", "saved scene reloads")
	DirAccess.remove_absolute(ProjectSettings.globalize_path("res://phase3/generated_scene.tscn"))
	print("PASS phase 3 scene lifecycle")
	quit(0 if failures.is_empty() else 1)
