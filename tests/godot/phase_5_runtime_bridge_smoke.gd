extends SceneTree

const SceneBridge = preload("res://addons/godot_control_mcp/runtime/scene_bridge.gd")
const InputBridge = preload("res://addons/godot_control_mcp/runtime/input_bridge.gd")

func _initialize() -> void:
	var root_node := Node.new(); root_node.name = "RuntimeRoot"; root.add_child(root_node)
	var cursor := root_node
	for i in range(40): var child := Node.new(); child.name = "N%d" % i; cursor.add_child(child); cursor = child
	var tree: Dictionary = SceneBridge.new().scene_tree(root_node, {"maxDepth":99})
	_assert(tree.nodes.size() == 33, "tree depth bound")
	_assert(InputBridge.new().perform({"kind":"key", "keycode":65, "pressed":true, "holdMs":2001}).has("error"), "input hold bound")
	print("PASS phase 5 locked runtime bridge")
	quit(0)

func _assert(value: bool, label: String) -> void:
	if not value: push_error("FAIL " + label); quit(1)
