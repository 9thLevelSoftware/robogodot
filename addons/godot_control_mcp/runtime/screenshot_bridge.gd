extends RefCounted

const MAX_PNG := 16 * 1024 * 1024
func capture(viewport: Viewport, shots_dir: String, params: Dictionary) -> Dictionary:
	var name: Variant = params.get("name", "shot.png")
	if not name is String or name.is_empty() or name.length() > 128 or name.get_file() != name or not name.ends_with(".png") or ".." in name: return {"error":"invalid screenshot name"}
	var path := shots_dir.path_join(name).simplify_path()
	if path.get_base_dir() != shots_dir.simplify_path(): return {"error":"screenshot path escaped"}
	DirAccess.make_dir_recursive_absolute(shots_dir)
	var image := viewport.get_texture().get_image(); var png := image.save_png_to_buffer()
	if png.is_empty() or png.size() > MAX_PNG: return {"error":"screenshot exceeds bound"}
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null: return {"error":"screenshot write failed"}
	file.store_buffer(png); file.close()
	return {"path":path, "format":"png", "width":image.get_width(), "height":image.get_height(), "bytes":png.size()}
