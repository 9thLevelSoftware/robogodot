@tool
extends RefCounted

const Compat = preload("../godot_compat.gd")
const Manifest = preload("../runtime/bridge_manifest.gd")
const REQUIRED_FIELDS := ["preferredPort", "protocolVersion", "sessionId", "token"]
static var _owned_sessions: Array[String] = []

static func prepare(params: Dictionary) -> Dictionary:
	var keys := params.keys()
	keys.sort()
	if keys.any(func(key): return key not in REQUIRED_FIELDS and key != "scene") or REQUIRED_FIELDS.any(func(key): return key not in keys):
		return _failure("Use sessionId, token, protocolVersion, preferredPort, and optional scene.")
	var session_id: Variant = params.sessionId
	var token: Variant = params.token
	var protocol_version: Variant = params.protocolVersion
	var preferred_port: Variant = params.preferredPort
	var scene: Variant = params.get("scene", ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene is String and scene.begins_with("uid://"):
		scene = ResourceUID.get_id_path(ResourceUID.text_to_id(scene))
	if not session_id is String or not _valid_session_id(session_id): return _failure("sessionId must be 32 lowercase hexadecimal characters.")
	if not token is String or token.to_utf8_buffer().size() < Manifest.MIN_TOKEN_BYTES or token.to_utf8_buffer().size() > Manifest.MAX_TOKEN_BYTES: return _failure("token must contain between 32 and 256 UTF-8 bytes.")
	if not _integer_variant(protocol_version) or int(protocol_version) != Manifest.PROTOCOL_VERSION: return _failure("protocolVersion is unsupported.")
	if not _integer_variant(preferred_port) or preferred_port < 1 or preferred_port > 65535: return _failure("preferredPort must be an integer from 1 to 65535.")
	var canonical_scene := Compat.canonical_project_path(scene)
	if canonical_scene.is_empty() or not ResourceLoader.exists(canonical_scene, "PackedScene"): return _failure("scene must name an existing canonical PackedScene resource.")
	var resources := Compat.verified_runtime_resources(Manifest.LAUNCHER_RESOURCE, Manifest.BRIDGE_RESOURCE)
	if not resources.ok: return _failure(resources.hint)
	var session := Compat.create_runtime_session(session_id)
	if not session.ok: return _failure(session.hint)
	_owned_sessions.append(session_id)
	return {"ok":true, "result":{"userRoot":session.user_root, "sessionRoot":session.session_root, "manifestVersion":Manifest.MANIFEST_VERSION, "launcherPath":resources.launcher_path, "bridgePath":resources.bridge_path, "scene":canonical_scene}}

static func _integer_variant(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and floorf(float(value)) == float(value)

static func owned_session_count() -> int:
	return _owned_sessions.size()

static func cleanup_owned_sessions() -> Error:
	var first_error := OK
	var owned := _owned_sessions.duplicate()
	var retry: Array[String] = []
	for session_id in owned:
		var error := Compat.cleanup_runtime_session(session_id)
		if error != OK:
			if first_error == OK: first_error = error
			if session_id not in retry: retry.append(session_id)
	_owned_sessions = retry
	return first_error

static func _valid_session_id(value: String) -> bool:
	if value.length() != 32 or value.to_utf8_buffer().size() != 32: return false
	for character in value:
		if character not in "0123456789abcdef": return false
	return true

static func _failure(hint: String) -> Dictionary:
	return {"ok":false, "hint":hint}
