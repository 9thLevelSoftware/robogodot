extends SceneTree

const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
const Router = preload("res://addons/godot_control_mcp/command_router.gd")
var failures: Array[String] = []

func _initialize() -> void: call_deferred("_run")
func _check(value: bool, message: String) -> void:
	if not value: failures.append(message); push_error(message)
func _frames(count: int = 20) -> void:
	for ignored in range(count): await process_frame

func _run() -> void:
	DirAccess.remove_absolute(ProjectSettings.globalize_path("res://phase3/generated_scene.tscn"))
	var boundary := "res://" + "é".repeat(506) + "a.tscn"
	_check(boundary.to_utf8_buffer().size() == 1024 and Compat.canonical_project_path(boundary) == boundary, "1024-byte project path accepted")
	_check(Compat.canonical_project_path("res://" + "é".repeat(507) + "a.tscn").is_empty(), "over-1024-byte project path rejected")
	Compat.scene_open("res://phase3/node_fixture.tscn")
	await _frames()
	var root := Compat.edited_scene_root()
	_check(root != null, "fixture opens")
	_check(not Compat.undo_history_has_undo(Compat.editor_undo_redo(), root), "open creates no UndoRedo action on resulting scene")
	var current: Dictionary = Edit.scene_current({})
	_check(current.ok and current.result.path == "res://phase3/node_fixture.tscn" and current.result.state != "clean", "current scene conservatively reports non-clean")
	var unknown_open: Dictionary = Edit.scene_open({"path": "res://phase3/node_fixture.tscn"})
	_check(not unknown_open.ok, "unknown state rejects unconfirmed open")
	var tree: Dictionary = Edit.scene_tree({"maxDepth": 1, "limit": 2})
	_check(tree.ok and tree.result.nodes.size() == 2 and tree.result.nodes[0].name == "Main" and tree.result.nodes[1].name == "A" and tree.result.nodes[1].parent == "/root/Main" and tree.result.truncated, "stable bounded flat tree page")
	var next: Dictionary = Edit.scene_tree({"maxDepth": 1, "limit": 2, "cursor": tree.result.nextCursor})
	_check(next.ok and next.result.nodes.size() == 1 and next.result.nodes[0].name == "B" and not next.result.truncated, "cursor continues deterministic traversal")
	var wide_nodes: Array[Node] = []
	for index in range(500):
		var wide := Node.new(); wide.name = "N%03d_%s" % [index, "é".repeat(120)]; root.add_child(wide); wide_nodes.append(wide)
	var router := Router.new(); router.register_command("edit.scene_tree", Edit.scene_tree)
	var maximum_id := "x".repeat(128)
	var response := router.dispatch({"jsonrpc": "2.0", "id": maximum_id, "method": "edit.scene_tree", "params": {"maxDepth": 1, "limit": 500}})
	var response_bytes := JSON.stringify(response).to_utf8_buffer().size()
	_check(response_bytes <= 262144 and response.result.truncated and int(response.result.nextCursor) > 0, "multibyte wide tree stays in complete router envelope and advances cursor")
	var seen := {}; var cursor := "0"
	while true:
		var page: Dictionary = Edit.scene_tree({"maxDepth": 1, "limit": 73, "cursor": cursor})
		_check(page.ok, "wide tree page succeeds")
		for record in page.result.nodes: _check(not seen.has(record.path), "tree pages contain no duplicates"); seen[record.path] = true
		if not page.result.truncated: break
		_check(int(page.result.nextCursor) > int(cursor), "every truncated page advances cursor"); cursor = page.result.nextCursor
	_check(seen.size() == 503, "concatenated pages have no skips")
	for wide in wide_nodes: wide.free()
	EditorInterface.set_object_edited(root.get_node("A"), true)
	var refused: Dictionary = Edit.scene_new({"rootType": "Node2D", "rootName": "Fresh"})
	_check(not refused.ok and Compat.edited_scene_root() == root, "new rejects unconfirmed discard")
	var created: Dictionary = Edit.scene_new({"rootType": "Node2D", "rootName": "Fresh", "discardUnsaved": true})
	await _frames()
	_check(created.ok and Compat.edited_scene_root().name == "Fresh", "new scene")
	var fresh_root := Compat.edited_scene_root()
	var fresh_history := Compat.undo_history_version(Compat.editor_undo_redo(), fresh_root)
	_check(not Compat.undo_history_has_undo(Compat.editor_undo_redo(), fresh_root), "new creates no UndoRedo action on resulting scene")
	var invalid_save: Dictionary = Edit.scene_save({"path": "res://missing-directory/generated_scene.tscn"})
	_check(not invalid_save.ok, "invalid destination fails honestly")
	var saved: Dictionary = Edit.scene_save({"path": "res://phase3/generated_scene.tscn"})
	await _frames()
	_check(saved.ok and FileAccess.file_exists("res://phase3/generated_scene.tscn"), "save new path")
	_check(Compat.undo_history_version(Compat.editor_undo_redo(), fresh_root) == fresh_history, "save does not add UndoRedo history")
	var denied_overwrite: Dictionary = Edit.scene_save({"path": "res://phase3/node_fixture.tscn"})
	_check(not denied_overwrite.ok, "existing different path requires overwrite")
	var overwritten: Dictionary = Edit.scene_save({"path": "res://phase3/generated_scene.tscn", "overwrite": true})
	_check(overwritten.ok, "same path save succeeds")
	var preexisting_root := Node.new(); preexisting_root.name = "Old"
	var preexisting := PackedScene.new(); preexisting.pack(preexisting_root); preexisting_root.free()
	preexisting.take_over_path("res://phase3/overwrite_target.tscn"); ResourceSaver.save(preexisting, "res://phase3/overwrite_target.tscn")
	var overwrite_target: Dictionary = Edit.scene_save({"path": "res://phase3/overwrite_target.tscn", "overwrite": true})
	_check(overwrite_target.ok and (load("res://phase3/overwrite_target.tscn") as PackedScene).instantiate().name == "Fresh", "confirmed pre-existing target overwritten and reloadable")
	_check(Compat.undo_history_version(Compat.editor_undo_redo(), fresh_root) == fresh_history, "save-as and overwrite create no UndoRedo action")
	var reopened: Dictionary = Edit.scene_open({"path": "res://phase3/generated_scene.tscn", "discardUnsaved": true})
	await _frames()
	_check(reopened.ok and Compat.edited_scene_root().name == "Fresh", "saved scene reloads")
	_check(not Compat.undo_history_has_undo(Compat.editor_undo_redo(), Compat.edited_scene_root()), "open creates no action in replacement scene history")
	var corrupt := FileAccess.open("res://phase3/corrupt.tscn", FileAccess.WRITE); corrupt.store_string("not a scene"); corrupt.close()
	var corrupt_open: Dictionary = Edit.scene_open({"path": "res://phase3/corrupt.tscn", "discardUnsaved": true})
	_check(not corrupt_open.ok, "corrupt existing scene fails honestly")
	DirAccess.remove_absolute(ProjectSettings.globalize_path("res://phase3/generated_scene.tscn"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path("res://phase3/overwrite_target.tscn"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path("res://phase3/corrupt.tscn"))
	print("PASS phase 3 scene lifecycle")
	quit(0 if failures.is_empty() else 1)
