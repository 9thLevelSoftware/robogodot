extends RefCounted

func perform(params: Dictionary) -> Dictionary:
	var kind: Variant = params.get("kind")
	var hold: Variant = params.get("holdMs", 0)
	if not hold is int or hold < 0 or hold > 2000: return {"error":"invalid hold"}
	var event: InputEvent
	if kind == "action":
		var action: Variant = params.get("action"); var mode: Variant = params.get("mode")
		if not action is String or action.length() > 128 or not InputMap.has_action(action) or mode not in ["press", "release", "press_release"]: return {"error":"invalid action"}
		event = InputEventAction.new(); event.action = action; event.pressed = mode != "release"
	elif kind == "key":
		var key: Variant = params.get("keycode"); var pressed: Variant = params.get("pressed")
		if not key is int or key < 0 or key > 0x7fffffff or not pressed is bool: return {"error":"invalid key"}
		event = InputEventKey.new(); event.keycode = key; event.pressed = pressed
	elif kind == "mouse_button":
		var button: Variant = params.get("button"); var pressed: Variant = params.get("pressed")
		if not button is int or button < 1 or button > 5 or not pressed is bool: return {"error":"invalid mouse button"}
		event = InputEventMouseButton.new(); event.button_index = button; event.pressed = pressed
	else: return {"error":"invalid input kind"}
	Input.parse_input_event(event)
	return {"ok":true}
