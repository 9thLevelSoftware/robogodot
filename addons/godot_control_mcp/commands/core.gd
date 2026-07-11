@tool
extends RefCounted

const PLUGIN_VERSION := "0.1.0"

static func ping(_params: Dictionary) -> Dictionary:
	return {"ok": true, "result": {"pong": true}}

static func get_version(_params: Dictionary) -> Dictionary:
	return {"ok": true, "result": {
		"engine": Engine.get_version_info(),
		"plugin": PLUGIN_VERSION,
		"projectPath": ProjectSettings.globalize_path("res://"),
		"connected": true,
	}}
