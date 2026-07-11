extends SceneTree

const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
var failures: Array[String] = []

func _initialize() -> void: call_deferred("_run")
func _check(value: bool, message: String) -> void:
	if not value: failures.append(message); push_error(message)

func _run() -> void:
	EditorInterface.open_scene_from_path("res://phase3/node_fixture.tscn")
	for ignored in range(30): await process_frame
	var root := EditorInterface.get_edited_scene_root()
	_check(root != null, "fixture must open")
	var undo: EditorUndoRedoManager = Compat.editor_undo_redo()
	var added: Dictionary = Edit.node_add({"parent": "/root/Main", "type": "Node2D", "name": "Added", "properties": {"position": "Vector2(10,20)"}})
	_check(added.ok and root.get_node_or_null("Added") != null, "add with initial property")
	var controller = preload("res://addons/godot_control_mcp/edit_controller.gd").new(undo)
	controller._last_history_target = root
	controller.undo(); _check(root.get_node_or_null("Added") == null, "undo add")
	controller.redo(); _check(root.get_node_or_null("Added") != null, "redo add")
	var renamed: Dictionary = Edit.node_rename({"path": "/root/Main/Added", "name": "Renamed"})
	_check(renamed.ok and root.get_node_or_null("Renamed") != null, "rename changes path")
	var set_result: Dictionary = Edit.node_set_property({"path": "/root/Main/Renamed", "property": "position", "value": {"$type": "Vector2", "x": 7, "y": 8}})
	_check(set_result.ok and root.get_node("Renamed").position == Vector2(7, 8), "set property Variant")
	var duplicated: Dictionary = Edit.node_duplicate({"path": "/root/Main/Renamed", "parent": "/root/Main", "name": "Copy", "flags": 15})
	_check(duplicated.ok and root.get_node_or_null("Copy") != null, "duplicate")
	var reparented: Dictionary = Edit.node_reparent({"path": "/root/Main/Copy", "parent": "/root/Main/B"})
	_check(reparented.ok and root.get_node_or_null("B/Copy") != null, "reparent")
	var deleted: Dictionary = Edit.node_delete({"path": "/root/Main/B/Copy"})
	_check(deleted.ok and root.get_node_or_null("B/Copy") == null, "delete")
	var stale: Dictionary = Edit.node_get({"path": "/root/Main/Missing"})
	_check(not stale.ok and "Current tree" in stale.hint, "stale path compact tree")
	var proto: Dictionary = Edit.node_set_property({"path": "/root/Main", "property": "__proto__", "value": 1})
	_check(not proto.ok, "prototype-like properties rejected")
	print("PASS phase 3 undoable node tools")
	quit(0 if failures.is_empty() else 1)
