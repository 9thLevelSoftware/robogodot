extends SceneTree

const Manifest = preload("bridge_manifest.gd")
const RuntimeBridge = preload("runtime_bridge.gd")
const CONFIG_FLAG := "--mcp-runtime-config"

func _initialize() -> void:
	_launch()

func _launch() -> void:
	var config_path := _config_path(OS.get_cmdline_user_args())
	if config_path.is_empty(): return _fail("Runtime config flag is missing.")
	var identity := _validate_config_identity(config_path)
	if not identity.ok: return _fail("Runtime config path is not approved.")
	var config := _read_config(config_path, identity.session_id)
	if config.is_empty(): return _fail("Runtime config is invalid.")
	if not _identity_unchanged(config_path, identity): return _fail("Runtime config identity changed.")
	var canonical_scene := _canonical_scene(config.scene)
	if canonical_scene.is_empty(): return _fail("Runtime scene path is invalid.")
	var packed := ResourceLoader.load(canonical_scene, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not packed is PackedScene: return _fail("Runtime scene could not be loaded.")
	if not _identity_unchanged(config_path, identity) or DirAccess.remove_absolute(config_path) != OK: return _fail("Runtime config could not be consumed safely.")
	var scene: Node = packed.instantiate()
	root.add_child(scene)
	_install_bridge_nodes(scene, config)

func _install_bridge_nodes(scene: Node, config: Dictionary) -> void:
	var bridge := RuntimeBridge.new()
	bridge.name = "RuntimeBridge"
	root.add_child(bridge)
	var runtime_config := config.duplicate(true)
	runtime_config.sessionRoot = ProjectSettings.globalize_path("user://.mcp").path_join(config.sessionId).simplify_path()
	bridge.setup(runtime_config, scene)

func _config_path(args: PackedStringArray) -> String:
	if args.count(CONFIG_FLAG) != 1: return ""
	var index := args.find(CONFIG_FLAG)
	if index < 0 or index + 1 >= args.size(): return ""
	var path := String(args[index + 1]).replace("\\", "/")
	return path if path.is_absolute_path() and path.simplify_path() == path else ""

func _validate_config_identity(path: String) -> Dictionary:
	if path.get_file() != "bridge-config-v%d.json" % Manifest.MANIFEST_VERSION: return {"ok":false}
	var session_id := path.get_base_dir().get_file()
	if not _valid_session_id(session_id): return {"ok":false}
	var approved := ProjectSettings.globalize_path("user://.mcp").simplify_path()
	var expected := approved.path_join(session_id).path_join(path.get_file()).simplify_path()
	if path != expected or not FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path): return {"ok":false}
	if _chain_has_link(approved, session_id, path.get_file()): return {"ok":false}
	var size := FileAccess.get_size(path)
	if size <= 0 or size > 32768: return {"ok":false}
	return {"ok":true, "session_id":session_id, "size":size, "modified":FileAccess.get_modified_time(path)}

func _identity_unchanged(path: String, identity: Dictionary) -> bool:
	var current := _validate_config_identity(path)
	return current.ok and current.session_id == identity.session_id and current.size == identity.size and current.modified == identity.modified

func _chain_has_link(approved: String, session_id: String, filename: String) -> bool:
	var user := DirAccess.open(approved.get_base_dir())
	var approved_dir := DirAccess.open(approved)
	var session := DirAccess.open(approved.path_join(session_id))
	return user == null or approved_dir == null or session == null or user.is_link(".mcp") or approved_dir.is_link(session_id) or session.is_link(filename)

func _read_config(path: String, expected_session: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null or file.get_length() > 32768: return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if not parsed is Dictionary: return {}
	var keys: Array = parsed.keys(); keys.sort()
	var expected: Array = ["bridgeResource", "launcherResource", "preferredPort", "protocolVersion", "scene", "sessionId", "token", "version"]
	if keys != expected or parsed.version != Manifest.MANIFEST_VERSION or parsed.protocolVersion != Manifest.PROTOCOL_VERSION: return {}
	if not parsed.token is String or parsed.token.to_utf8_buffer().size() < 32 or parsed.token.to_utf8_buffer().size() > 256: return {}
	if not parsed.sessionId is String or parsed.sessionId != expected_session or not _valid_session_id(parsed.sessionId): return {}
	if not (parsed.preferredPort is int or parsed.preferredPort is float) or not is_finite(float(parsed.preferredPort)) or floorf(float(parsed.preferredPort)) != float(parsed.preferredPort) or parsed.preferredPort < 1 or parsed.preferredPort > 65535: return {}
	if parsed.launcherResource != Manifest.LAUNCHER_RESOURCE or parsed.bridgeResource != Manifest.BRIDGE_RESOURCE: return {}
	if _canonical_scene(parsed.scene).is_empty(): return {}
	return parsed

func _valid_session_id(value: String) -> bool:
	if value.length() != 32 or value.to_utf8_buffer().size() != 32: return false
	for character in value:
		if character not in "0123456789abcdef": return false
	return true

func _canonical_scene(value: Variant) -> String:
	if not value is String or value.is_empty() or value.to_utf8_buffer().size() > 1024 or not value.begins_with("res://") or "\\" in value or "%" in value: return ""
	var parts: PackedStringArray = value.substr(6).split("/", true)
	if parts.is_empty(): return ""
	for part in parts:
		if part.is_empty() or part == "." or part == "..": return ""
	var global := ProjectSettings.globalize_path(value).simplify_path()
	if ProjectSettings.localize_path(global) != value: return ""
	if not ResourceLoader.exists(value, "PackedScene"): return ""
	return value

func _fail(message: String) -> void:
	push_error(message)
	quit(1)
