@tool
extends RefCounted

const Compat = preload("../godot_compat.gd")
const MAX_LIST_LIMIT := 200
const MAX_SEARCH_LIMIT := 100
const MAX_QUERY_BYTES := 128

static func list_classes(params: Dictionary) -> Dictionary:
	var page := _page(params, 100, MAX_LIST_LIMIT)
	if not page.ok: return page
	var names: Array[String] = Compat.class_names()
	var offset: int = page.result.offset
	var limit: int = page.result.limit
	var page_end := mini(offset + limit, names.size())
	var values: Array[String] = []
	if offset < names.size(): values.assign(names.slice(offset, page_end))
	return _success({"classes": values, "total": names.size(), "offset": offset, "limit": limit, "hasMore": page_end < names.size()})

static func describe_class(params: Dictionary) -> Dictionary:
	var target_class = params.get("class")
	if not target_class is String or target_class.is_empty() or not Compat.class_exists(target_class):
		return _failure("Provide 'class' as a known ClassDB class name, for example 'Node'.")
	var member_page := _named_page(params, "memberOffset", "memberLimit", 200, 500)
	if not member_page.ok: return member_page
	var methods: Array[Dictionary] = []
	for raw in Compat.class_methods(target_class):
		var args: Array[Dictionary] = []
		for argument in raw.get("args", []): args.append(_typed_member(argument))
		var flags: int = raw.get("flags", 0)
		var method_name := String(raw.get("name", ""))
		var signature := "%s(%s)" % [method_name, ",".join(args.map(func(value): return "%s:%s:%s" % [value.name, value.type, value.class]))]
		methods.append({"name": method_name, "signature": signature, "args": args, "return": _typed_member(raw.get("return", {})), "static": (flags & METHOD_FLAG_STATIC) != 0, "vararg": (flags & METHOD_FLAG_VARARG) != 0, "owner": target_class, "declaredHere": true})
	methods.sort_custom(func(a, b): return a.name < b.name or (a.name == b.name and a.signature < b.signature))
	var properties: Array[Dictionary] = []
	for raw in Compat.class_properties(target_class):
		properties.append({"name": String(raw.get("name", "")), "type": Compat.variant_type_name(raw.get("type", TYPE_NIL)), "class": String(raw.get("class_name", "")), "usage": int(raw.get("usage", 0)), "owner": target_class, "declaredHere": true})
	properties.sort_custom(func(a, b): return a.name < b.name)
	var signals: Array[Dictionary] = []
	for raw in Compat.class_signals(target_class):
		var args: Array[Dictionary] = []
		for argument in raw.get("args", []): args.append(_typed_member(argument))
		var signal_name := String(raw.get("name", ""))
		signals.append({"name": signal_name, "signature": "%s(%s)" % [signal_name, ",".join(args.map(func(value): return "%s:%s:%s" % [value.name, value.type, value.class]))], "args": args, "owner": target_class, "declaredHere": true})
	signals.sort_custom(func(a, b): return a.name < b.name)
	var enums: Array[Dictionary] = []
	var enum_constants: Dictionary = {}
	for enum_value in Compat.class_enums(target_class):
		var enum_name := String(enum_value)
		var values: Array[Dictionary] = []
		for value in Compat.enum_constants(target_class, enum_name):
			var constant_name := String(value)
			enum_constants[constant_name] = true
			values.append({"name": constant_name, "value": Compat.constant_value(target_class, constant_name)})
		values.sort_custom(func(a, b): return a.name < b.name)
		enums.append({"name": enum_name, "values": values, "owner": target_class, "declaredHere": true})
	enums.sort_custom(func(a, b): return a.name < b.name)
	var constants: Array[Dictionary] = []
	for value in Compat.class_constants(target_class):
		var constant_name := String(value)
		if not enum_constants.has(constant_name): constants.append({"name": constant_name, "value": Compat.constant_value(target_class, constant_name), "owner": target_class, "declaredHere": true})
	constants.sort_custom(func(a, b): return a.name < b.name)
	var combined: Array[Dictionary] = []
	for value in methods: combined.append({"category": "methods", "value": value})
	for value in properties: combined.append({"category": "properties", "value": value})
	for value in signals: combined.append({"category": "signals", "value": value})
	for value in enums: combined.append({"category": "enums", "value": value})
	for value in constants: combined.append({"category": "constants", "value": value})
	methods = []; properties = []; signals = []; enums = []; constants = []
	var member_offset: int = member_page.result.offset
	var member_limit: int = member_page.result.limit
	var member_end := mini(member_offset + member_limit, combined.size())
	if member_offset < combined.size():
		for wrapped in combined.slice(member_offset, member_end):
			match wrapped.category:
				"methods": methods.append(wrapped.value)
				"properties": properties.append(wrapped.value)
				"signals": signals.append(wrapped.value)
				"enums": enums.append(wrapped.value)
				"constants": constants.append(wrapped.value)
	return _success({"class": target_class, "inherits": Compat.parent_class(target_class), "includeInherited": false, "memberPage": {"offset": member_offset, "limit": member_limit, "total": combined.size(), "hasMore": member_end < combined.size()}, "methods": methods, "properties": properties, "signals": signals, "enums": enums, "constants": constants})

static func search(params: Dictionary) -> Dictionary:
	var query = params.get("query")
	if not query is String or query.strip_edges().is_empty() or query.to_utf8_buffer().size() > MAX_QUERY_BYTES:
		return _failure("Provide a nonempty UTF-8 'query' of at most 128 bytes.")
	var page := _page(params, 25, MAX_SEARCH_LIMIT)
	if not page.ok: return page
	var needle: String = query.strip_edges().to_lower()
	var matches: Array[Dictionary] = []
	for target_class in Compat.class_names():
		if needle in target_class.to_lower(): matches.append({"kind": "class", "class": target_class})
	matches.sort_custom(compare_search_results)
	var offset: int = page.result.offset
	var limit: int = page.result.limit
	var page_end := mini(offset + limit, matches.size())
	var results: Array[Dictionary] = []
	if offset < matches.size(): results.assign(matches.slice(offset, page_end))
	return _success({"query": query.strip_edges(), "results": results, "total": matches.size(), "offset": offset, "limit": limit, "hasMore": page_end < matches.size()})

static func compare_search_results(a: Dictionary, b: Dictionary) -> bool:
	return "%s|%s|%s" % [a.get("class", ""), a.get("kind", ""), a.get("member", "")] < "%s|%s|%s" % [b.get("class", ""), b.get("kind", ""), b.get("member", "")]

static func _typed_member(raw: Dictionary) -> Dictionary:
	return {"name": String(raw.get("name", "")), "type": Compat.variant_type_name(raw.get("type", TYPE_NIL)), "class": String(raw.get("class_name", ""))}

static func _page(params: Dictionary, default_limit: int, max_limit: int) -> Dictionary:
	return _named_page(params, "offset", "limit", default_limit, max_limit)

static func _named_page(params: Dictionary, offset_name: String, limit_name: String, default_limit: int, max_limit: int) -> Dictionary:
	var offset = params.get(offset_name, 0)
	var limit = params.get(limit_name, default_limit)
	if not (offset is int or offset is float) or float(offset) != floorf(float(offset)) or offset < 0: return _failure("'%s' must be a nonnegative integer." % offset_name)
	if not (limit is int or limit is float) or float(limit) != floorf(float(limit)) or limit < 1 or limit > max_limit: return _failure("'%s' must be between 1 and %d." % [limit_name, max_limit])
	return _success({"offset": int(offset), "limit": int(limit)})

static func _success(result: Dictionary) -> Dictionary:
	return {"ok": true, "result": result}

static func _failure(hint: String) -> Dictionary:
	return {"ok": false, "hint": hint}
