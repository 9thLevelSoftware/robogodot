extends SceneTree

const Compat = preload("res://addons/godot_control_mcp/godot_compat.gd")
const EditController = preload("res://addons/godot_control_mcp/edit_controller.gd")
const Edit = preload("res://addons/godot_control_mcp/commands/edit.gd")
var failures: Array[String] = []

class Receiver extends Node:
	func on_ready() -> void: pass
	func on_changed(_value: int = 0) -> void: pass

class Emitter extends Node:
	signal changed(value: int)
	signal é_changed(text: String)

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
	main.queue_free()
	EditorInterface.open_scene_from_path("res://phase3/node_fixture.tscn")
	for ignored in range(30): await process_frame
	var edited := EditorInterface.get_edited_scene_root()
	var emitter := Emitter.new(); emitter.name = "Emitter"; edited.add_child(emitter); emitter.owner = edited
	for index in range(260):
		var listed_receiver := Receiver.new(); listed_receiver.name = "R%03d_é" % (259 - index); edited.add_child(listed_receiver); listed_receiver.owner = edited
		emitter.changed.connect(Callable(listed_receiver, &"on_changed"), CONNECT_DEFERRED if index % 2 == 0 else CONNECT_PERSIST)
	var outside := Receiver.new(); outside.name = "Outside"; root.add_child(outside); emitter.changed.connect(Callable(outside, &"on_changed"))
	var first_page: Dictionary = Edit.signal_list({"path": "/root/Main/Emitter", "cursor": "0", "limit": 1})
	_check(first_page.ok and first_page.result.signals.size() == 1 and first_page.result.truncated and first_page.result.nextCursor == "1", "signal list first page cursor")
	var names: Array[String] = []; var cursor := "0"
	while true:
		var page: Dictionary = Edit.signal_list({"path": "/root/Main/Emitter", "cursor": cursor, "limit": 1})
		_check(page.ok, "signal page succeeds")
		if not page.ok: break
		for item in page.result.signals: names.append(String(item.name))
		if not page.result.truncated: break
		cursor = page.result.nextCursor
	_check(names.size() == emitter.get_signal_list().size() and names.all(func(name): return names.count(name) == 1), "cursor progression has no duplicate or skip")
	_check(names.has("ready") and names.has("changed") and names.has("é_changed"), "native inherited and script signals listed")
	var changed_index := names.find("changed")
	var changed_page: Dictionary = Edit.signal_list({"path": "/root/Main/Emitter", "cursor": str(changed_index), "limit": 1})
	var changed: Dictionary = changed_page.result.signals[0]
	_check(changed.arguments.size() == 1 and changed.arguments[0].name == "value" and changed.arguments[0].type == TYPE_INT, "signal argument metadata")
	_check(changed.connectionCount == 260 and changed.connectionsTruncated and changed.connections.size() == 256, "connection count and deterministic cap")
	_check(changed.connections[0].callable.target == "/root/Main/R000_é" and changed.connections[255].callable.target == "/root/Main/R255_é", "connections filtered then stably sorted before cap")
	_check(not Edit.signal_list({"path": "/root/Main/Emitter", "cursor": "00", "limit": 1}).ok and not Edit.signal_list({"path": "/root/Main/Emitter", "cursor": "100001", "limit": 1}).ok, "invalid and boundary cursor rejected")
	var end_page: Dictionary = Edit.signal_list({"path": "/root/Main/Emitter", "cursor": str(names.size()), "limit": 1})
	_check(end_page.ok and end_page.result.signals.is_empty() and not end_page.result.truncated, "end cursor is empty")
	_check(JSON.stringify(changed_page.result).to_utf8_buffer().size() < 262144, "multibyte connection page stays bounded")
	outside.queue_free(); print("PASS phase 3 signal instance"); quit(0 if failures.is_empty() else 1)
