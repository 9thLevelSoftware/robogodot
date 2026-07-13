extends Node2D

@export var jump_count: int = 0
var _jump_was_pressed := false

func _ready() -> void:
	print("PHASE5_READY")
	queue_redraw()

func _process(_delta: float) -> void:
	var jump_pressed := Input.is_action_pressed("phase5_jump")
	if jump_pressed and not _jump_was_pressed:
		var phase5_value = 42
		jump_count += 1
		print("PHASE5_JUMP:%d:%d" % [jump_count, phase5_value])
		queue_redraw()
	_jump_was_pressed = jump_pressed

func _draw() -> void:
	draw_rect(Rect2(0, 0, 320, 180), Color("24324a"), true)
	draw_circle(Vector2(160, 90 - jump_count * 4), 24, Color("5de4c7"))
