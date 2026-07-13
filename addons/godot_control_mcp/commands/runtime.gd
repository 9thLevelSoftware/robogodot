@tool
extends RefCounted

const Compat = preload("../godot_compat.gd")
const Manifest = preload("../runtime/bridge_manifest.gd")
const FIELDS := ["preferredPort", "protocolVersion", "scene", "sessionId", "token"]
const MIN_TOKEN_BYTES := 32
const MAX_TOKEN_BYTES := 256

static func prepare(params: Dictionary) -> Dictionary:
	var keys := params.keys()
	keys.sort()
	if keys != FIELDS:
		return _failure("Use exactly sessionId, token, protocolVersion, preferredPort, and scene.")
	var session_id: Variant = params.sessionId
	var token: Variant = params.token
	var protocol_version: Variant = params.protocolVersion
	var preferred_port: Variant = params.preferredPort
	var scene: Variant = params.scene
	if not session_id is String or not _valid_session_id(session_id): return _failure("sessionId must be 32 lowercase hexadecimal characters.")
	if not token is String or token.to_utf8_buffer().size() < MIN_TOKEN_BYTES or token.to_utf8_buffer().size() > MAX_TOKEN_BYTES: return _failure("token must contain between 32 and 256 UTF-8 bytes.")
	if not protocol_version is int or protocol_version != Manifest.PROTOCOL_VERSION: return _failure("protocolVersion is unsupported.")
	if not preferred_port is int or preferred_port < 1 or preferred_port > 65535: return _failure("preferredPort must be an integer from 1 to 65535.")
	var canonical_scene := Compat.canonical_project_path(scene)
	if canonical_scene.is_empty() or not ResourceLoader.exists(canonical_scene, "PackedScene"): return _failure("scene must name an existing canonical PackedScene resource.")
	var resources := Compat.verified_runtime_resources(Manifest.LAUNCHER_RESOURCE, Manifest.BRIDGE_RESOURCE)
	if not resources.ok: return _failure(resources.hint)
	var session := Compat.create_runtime_session(session_id)
	if not session.ok: return _failure(session.hint)
	return {"ok":true, "result":{"userRoot":session.user_root, "sessionRoot":session.session_root, "manifestVersion":Manifest.MANIFEST_VERSION, "launcherPath":resources.launcher_path, "bridgePath":resources.bridge_path}}

static func _valid_session_id(value: String) -> bool:
	if value.length() != 32 or value.to_utf8_buffer().size() != 32: return false
	for character in value:
		if character not in "0123456789abcdef": return false
	return true

static func _failure(hint: String) -> Dictionary:
	return {"ok":false, "hint":hint}
