extends SceneTree

const Manifest = preload("bridge_manifest.gd")
const CONFIG_FLAG := "--mcp-runtime-config"

func _initialize() -> void:
	call_deferred("_launch")

func _launch() -> void:
	var config_path := _config_path(OS.get_cmdline_user_args())
	if config_path.is_empty(): return _fail("Runtime config flag is missing.")
	var config := _read_config(config_path)
	DirAccess.remove_absolute(config_path)
	if config.is_empty(): return _fail("Runtime config is invalid.")
	var packed := ResourceLoader.load(config.scene, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not packed is PackedScene: return _fail("Runtime scene could not be loaded.")
	var scene: Node = packed.instantiate()
	root.add_child(scene)
	_install_bridge_nodes(scene, config)

func _install_bridge_nodes(_scene: Node, _config: Dictionary) -> void:
	# Task 4 installs authenticated bridge nodes at this child-only seam.
	pass

func _config_path(args: PackedStringArray) -> String:
	if args.count(CONFIG_FLAG) != 1: return ""
	var index := args.find(CONFIG_FLAG)
	if index < 0 or index + 1 >= args.size(): return ""
	var path := String(args[index + 1])
	return path.simplify_path() if path.is_absolute_path() else ""

func _read_config(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null or file.get_length() > 32768: return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if not parsed is Dictionary: return {}
	var keys: Array = parsed.keys(); keys.sort()
	var expected: Array = ["bridgeResource", "launcherResource", "preferredPort", "protocolVersion", "scene", "sessionId", "token", "version"]
	if keys != expected or parsed.version != Manifest.MANIFEST_VERSION or parsed.protocolVersion != Manifest.PROTOCOL_VERSION: return {}
	if not parsed.token is String or parsed.token.to_utf8_buffer().size() < 32 or parsed.token.to_utf8_buffer().size() > 256: return {}
	if not parsed.sessionId is String or parsed.sessionId.length() != 32: return {}
	if not parsed.preferredPort is int or parsed.preferredPort < 1 or parsed.preferredPort > 65535: return {}
	if parsed.launcherResource != Manifest.LAUNCHER_RESOURCE or parsed.bridgeResource != Manifest.BRIDGE_RESOURCE: return {}
	if not parsed.scene is String or not parsed.scene.begins_with("res://") or ".." in parsed.scene or "\\" in parsed.scene: return {}
	return parsed

func _fail(message: String) -> void:
	push_error(message)
	quit(1)
