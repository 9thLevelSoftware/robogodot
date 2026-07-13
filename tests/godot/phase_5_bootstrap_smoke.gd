extends SceneTree

const Router = preload("../../addons/godot_control_mcp/command_router.gd")
const Runtime = preload("../../addons/godot_control_mcp/commands/runtime.gd")
const Compat = preload("../../addons/godot_control_mcp/godot_compat.gd")
const TOKEN := "runtime-token-0123456789abcdef-runtime-token-0123456789abcdef"
const SESSION := "0123456789abcdef0123456789abcdef"
var failures: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)
		push_error(message)

func _run() -> void:
	Compat.cleanup_runtime_session(SESSION)
	var router := Router.new()
	_check(router.register_command("runtime.prepare", Runtime.prepare), "runtime.prepare must register")
	var oversized_method := router.dispatch({"jsonrpc":"2.0", "id":0, "method":"x".repeat(129), "params":{}})
	_check(oversized_method.get("error", {}).get("code") == -32600, "router must reject oversized authenticated method names before lookup")
	var request := {"jsonrpc":"2.0", "id":1, "method":"runtime.prepare", "params":{"sessionId":SESSION, "token":TOKEN, "protocolVersion":1, "preferredPort":19301, "scene":"res://test_scene.tscn"}}
	var response := router.dispatch(request)
	var result: Dictionary = response.get("result", {})
	var canonical_user := Compat.canonical_user_root()
	_check(not canonical_user.is_empty() and result.get("userRoot") == canonical_user, "user:// must be globalized canonically by the plugin boundary")
	_check(result.get("sessionRoot") == canonical_user.path_join(".mcp").path_join(SESSION), "session root must be exact canonical containment")
	_check(result.get("manifestVersion") == 1, "manifest version must be fixed")
	_check(result.get("launcherPath", "").ends_with("runtime_launcher.gd"), "launcher resource must be verified")
	_check(result.get("bridgePath", "").ends_with("bridge_manifest.gd"), "bridge manifest resource must be verified")
	_check(not JSON.stringify(response).contains(TOKEN), "RPC result must not return the token")
	_check(DirAccess.dir_exists_absolute(result.get("sessionRoot", "")), "exact session directory must exist")
	_check(not ProjectSettings.has_setting("autoload/GodotControlMcpRuntime"), "bootstrap must not persist an autoload")
	var duplicate := router.dispatch(request)
	_check(duplicate.has("error"), "duplicate session must be rejected")
	for bad in [
		{"sessionId":"../escape", "token":TOKEN, "protocolVersion":1, "preferredPort":19301, "scene":"res://test_scene.tscn"},
		{"sessionId":"fedcba9876543210fedcba9876543210", "token":"short", "protocolVersion":1, "preferredPort":19301, "scene":"res://test_scene.tscn"},
		{"sessionId":"fedcba9876543210fedcba9876543210", "token":TOKEN, "protocolVersion":1, "preferredPort":19301, "scene":"res://../escape.tscn"},
	]:
		_check(router.dispatch({"jsonrpc":"2.0", "id":2, "method":"runtime.prepare", "params":bad}).has("error"), "invalid traversal/token input must be rejected")
	_check(Compat.cleanup_runtime_session(SESSION) == OK, "exact session cleanup must succeed")
	_check(Compat.cleanup_runtime_session(SESSION) == OK, "exact session cleanup must be idempotent")
	_check(not DirAccess.dir_exists_absolute(result.get("sessionRoot", "")), "cleanup must remove only the exact session")
	print("PASS phase 5 authenticated bridge bootstrap")
	quit(0 if failures.is_empty() else 1)
