extends SceneTree

const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
const EditController = preload("res://addons/godot_control_mcp/edit_controller.gd")
var failures: Array[String] = []

class Receiver extends Node:
	func on_ready() -> void: pass

func _check(value: bool, message: String) -> void:
	if not value: failures.append(message); push_error(message)

func _initialize() -> void: call_deferred("_run")

func _run() -> void:
	var main := Node.new(); main.name = "Main"; root.add_child(main)
	var undo: EditorUndoRedoManager
	for ignored in range(120):
		undo = Compat.editor_undo_redo()
		if undo != null: break
		await process_frame
	if undo == null: quit(1); return
	var controller = EditController.new(undo)
	var packed := load("res://phase3/instanced_child.tscn") as PackedScene
	var instance := packed.instantiate()
	var version := Compat.undo_history_version(undo, main)
	_check(controller.instance_scene(main, instance, main, "Instance scene").ok, "instance must succeed")
	_check(Compat.undo_history_version(undo, main) == version + 1, "instance adds one action")
	_check(instance.owner == main and instance.scene_file_path == "res://phase3/instanced_child.tscn", "instance owner and scene identity preserved")
	controller.undo(); _check(instance.get_parent() == null, "instance undo removes")
	controller.redo(); _check(instance.get_parent() == main, "instance redo restores")

	var receiver := Receiver.new(); receiver.name = "Receiver"; main.add_child(receiver)
	var callable := Callable(receiver, &"on_ready")
	version = Compat.undo_history_version(undo, main)
	_check(controller.connect_signal(main, &"ready", callable, CONNECT_DEFERRED | CONNECT_ONE_SHOT, "Connect ready").ok, "connect succeeds")
	_check(Compat.undo_history_version(undo, main) == version + 1 and main.is_connected(&"ready", callable), "connect adds exactly one action")
	controller.undo(); _check(not main.is_connected(&"ready", callable), "connect undo disconnects exact callable")
	controller.redo(); _check(main.is_connected(&"ready", callable), "connect redo restores")
	version = Compat.undo_history_version(undo, main)
	_check(not controller.connect_signal(main, &"ready", callable, 0, "Duplicate").ok and Compat.undo_history_version(undo, main) == version, "duplicate leaves history")
	_check(controller.disconnect_signal(main, &"ready", callable, "Disconnect ready").ok, "disconnect succeeds")
	controller.undo()
	var restored := main.get_signal_connection_list(&"ready")[0] as Dictionary
	_check(int(restored.flags) == (CONNECT_DEFERRED | CONNECT_ONE_SHOT), "disconnect undo restores exact flags")
	controller.redo(); version = Compat.undo_history_version(undo, main)
	_check(not controller.disconnect_signal(main, &"ready", callable, "Missing").ok and Compat.undo_history_version(undo, main) == version, "missing disconnect leaves history")
	main.queue_free(); print("PASS phase 3 signal instance"); quit(0 if failures.is_empty() else 1)
