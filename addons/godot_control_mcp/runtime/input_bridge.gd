extends Node

var _generation := 1
var _held: Dictionary = {}
var _next_hold := 1

func perform(params: Dictionary) -> Dictionary:
	var kind: Variant = params.get("kind"); var hold: Variant = params.get("holdMs", 0)
	if not _bounded_integer(hold, 0, 2000): return {"error":"invalid hold"}
	hold = int(hold)
	var event: InputEvent; var release: InputEvent; var should_release := false
	if kind == "action":
		var action: Variant = params.get("action"); var mode: Variant = params.get("mode")
		if not action is String or action.length() > 128 or not InputMap.has_action(action) or mode not in ["press", "release", "press_release"]: return {"error":"invalid action"}
		if mode == "release": Input.action_release(action)
		else: Input.action_press(action); should_release = mode == "press_release"
		if should_release: _schedule_release({"kind":"action", "action":action}, hold)
		return {"ok":true}
	elif kind == "key":
		var key: Variant = params.get("keycode"); var pressed: Variant = params.get("pressed")
		if not _bounded_integer(key, 0, 0x7fffffff) or not pressed is bool: return {"error":"invalid key"}
		event = InputEventKey.new(); event.keycode = int(key); event.pressed = pressed; should_release = pressed and hold > 0
	elif kind == "mouse_button":
		var button: Variant = params.get("button"); var pressed: Variant = params.get("pressed")
		if not _bounded_integer(button, 1, 5) or not pressed is bool: return {"error":"invalid mouse button"}
		event = InputEventMouseButton.new(); event.button_index = int(button); event.pressed = pressed; should_release = pressed and hold > 0
	else: return {"error":"invalid input kind"}
	Input.parse_input_event(event)
	if should_release:
		release = event.duplicate(); release.pressed = false
		_schedule_release(release, hold)
	return {"ok":true}

func _schedule_release(event: Variant, hold_ms: int) -> void:
	var id := _next_hold; _next_hold += 1; var generation := _generation; _held[id] = event
	get_tree().create_timer(float(hold_ms) / 1000.0).timeout.connect(func():
		if generation != _generation or not _held.has(id): return
		var release: Variant = _held[id]; _held.erase(id); _release(release)
	, CONNECT_ONE_SHOT)

func release_all() -> void:
	_generation += 1
	for event in _held.values(): _release(event)
	_held.clear()

func _release(value: Variant) -> void:
	if value is Dictionary and value.get("kind") == "action": Input.action_release(value.action)
	elif value is InputEvent: Input.parse_input_event(value)

func _bounded_integer(value: Variant, minimum: int, maximum: int) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and float(value) == floor(float(value)) and value >= minimum and value <= maximum
