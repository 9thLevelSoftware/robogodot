extends SceneTree

const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
const EditController = preload("res://addons/godot_control_mcp/edit_controller.gd")
var failures: Array[String] = []

class ReadOnlyFixture extends RefCounted:
	var read_only_value: int:
		get:
			return 7

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _run() -> void:
	var main := Node.new()
	main.name = "Main"
	root.add_child(main)
	var undo: EditorUndoRedoManager = null
	for ignored in range(120):
		undo = Compat.editor_undo_redo()
		if undo != null:
			break
		await process_frame
	_check(undo != null, "editor undo manager must become available")
	if undo == null:
		main.queue_free()
		quit(1)
		return
	var controller = EditController.new(undo)
	var child := Node2D.new()
	child.name = "A"

	var version := Compat.undo_history_version(undo, main)
	_check(controller.add_node(main, child, "Add A").ok, "add_node must succeed")
	_check(Compat.undo_history_version(undo, main) == version + 1, "add_node must add exactly one history version")
	_check(main.get_node_or_null("A") == child, "add_node must attach the node")
	controller.undo()
	_check(child.get_parent() == null, "one undo must remove the added node")
	controller.redo()
	_check(child.get_parent() == main, "redo must restore the added node")

	version = Compat.undo_history_version(undo, child)
	_check(controller.rename_node(child, "Renamed", "Rename A").ok, "rename_node must succeed")
	_check(Compat.undo_history_version(undo, child) == version + 1, "rename_node must add exactly one history version")
	controller.undo()
	_check(child.name == "A", "one undo must restore the old name")
	controller.redo()
	_check(child.name == "Renamed", "redo must restore the new name")

	version = Compat.undo_history_version(undo, child)
	_check(controller.set_property(child, &"position", Vector2(10, 20), "Set position").ok, "set_property must succeed")
	_check(Compat.undo_history_version(undo, child) == version + 1, "set_property must add exactly one history version")
	controller.undo()
	_check(child.position == Vector2.ZERO, "one undo must restore the old property")
	controller.redo()
	_check(child.position == Vector2(10, 20), "redo must restore the new property")

	version = Compat.undo_history_version(undo, child)
	_check(not controller.rename_node(null, "Nope", "Invalid rename").ok, "invalid target must fail")
	_check(Compat.undo_history_version(undo, child) == version, "invalid target must not change history")

	version = Compat.undo_history_version(undo, main)
	_check(not controller.add_node(main, child, "Invalid add").ok, "attached add target must fail")
	_check(Compat.undo_history_version(undo, main) == version, "invalid add must not change history")

	version = Compat.undo_history_version(undo, child)
	_check(not controller.set_property(child, &"missing_property", 1, "Invalid property").ok, "unknown property must fail")
	_check(Compat.undo_history_version(undo, child) == version, "unknown property must not change history")

	var read_only := ReadOnlyFixture.new()
	version = Compat.undo_history_version(undo, read_only)
	_check(not controller.set_property(read_only, &"read_only_value", 8, "Read-only property").ok, "read-only property must fail")
	_check(read_only.read_only_value == 7, "read-only property must remain unchanged")
	_check(Compat.undo_history_version(undo, read_only) == version, "read-only property must not change history")

	main.queue_free()
	print("PASS phase 3 edit controller foundation")
	quit(0 if failures.is_empty() else 1)
