extends Node
class_name Phase4IntelligenceFixture

var phase4_sprite: Sprite2D

func phase4_sum(left: int, right: int) -> int:
	return left + right

func phase4_probe() -> void:
	phase4_sprite.queue_free()
	phase4_sum(1, 2)
