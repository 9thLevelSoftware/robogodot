@tool
extends RefCounted

const MAX_DEPTH := 32
const FORBIDDEN_KEYS := ["__proto__", "prototype", "constructor"]

static func supported(value: Variant, depth: int = 0) -> bool:
	if depth > MAX_DEPTH: return false
	var kind := typeof(value)
	if kind in [TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]: return true
	if kind == TYPE_FLOAT: return is_finite(value)
	if kind == TYPE_VECTOR2: return is_finite(value.x) and is_finite(value.y)
	if kind == TYPE_VECTOR3: return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)
	if kind == TYPE_RECT2: return supported(value.position, depth + 1) and supported(value.size, depth + 1)
	if kind == TYPE_COLOR: return is_finite(value.r) and is_finite(value.g) and is_finite(value.b) and is_finite(value.a)
	if kind == TYPE_ARRAY:
		for item in value:
			if not supported(item, depth + 1): return false
		return true
	if kind == TYPE_DICTIONARY:
		for key in value:
			if not key is String or key in FORBIDDEN_KEYS or not supported(value[key], depth + 1): return false
		return true
	return false

static func equal(left: Variant, right: Variant, depth: int = 0) -> bool:
	if depth > MAX_DEPTH or typeof(left) != typeof(right) or not supported(left, depth) or not supported(right, depth): return false
	var kind := typeof(left)
	if kind == TYPE_FLOAT: return atan2(left, -1.0) == atan2(right, -1.0) if left == 0.0 and right == 0.0 else left == right
	if kind == TYPE_ARRAY:
		if left.size() != right.size(): return false
		for index in range(left.size()):
			if not equal(left[index], right[index], depth + 1): return false
		return true
	if kind == TYPE_DICTIONARY:
		if left.size() != right.size(): return false
		for key in left:
			if not right.has(key) or not equal(left[key], right[key], depth + 1): return false
		return true
	return left == right
