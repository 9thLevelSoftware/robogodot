extends RefCounted

const MAX_PNG := 16 * 1024 * 1024
func capture(viewport: Viewport, shots_dir: String, params: Dictionary) -> Dictionary:
	var name: Variant = params.get("name", "shot.png")
	if not name is String or name.is_empty() or name.to_utf8_buffer().size() > 256 or name.get_file() != name or not name.ends_with(".png") or ".." in name: return {"error":"invalid screenshot name"}
	var path := shots_dir.path_join(name).simplify_path()
	if path.get_base_dir() != shots_dir.simplify_path(): return {"error":"screenshot path escaped"}
	if DisplayServer.get_name() == "headless" or viewport == null or viewport.get_texture() == null: return {"error":"screenshot viewport unavailable"}
	if DirAccess.make_dir_recursive_absolute(shots_dir) != OK or _chain_has_link(shots_dir): return {"error":"screenshot directory unsafe"}
	if FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path): return {"error":"screenshot already exists"}
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty() or image.get_width() <= 0 or image.get_height() <= 0: return {"error":"screenshot readback failed"}
	return publish_image(image, shots_dir, name)

func publish_image(image: Image, shots_dir: String, name: String) -> Dictionary:
	var path := shots_dir.path_join(name).simplify_path()
	if name.is_empty() or name.get_file() != name or not name.ends_with(".png") or path.get_base_dir() != shots_dir.simplify_path(): return {"error":"invalid screenshot name"}
	if DirAccess.make_dir_recursive_absolute(shots_dir) != OK or _chain_has_link(shots_dir) or FileAccess.file_exists(path): return {"error":"screenshot directory unsafe"}
	if image == null or image.is_empty() or image.get_width() <= 0 or image.get_height() <= 0: return {"error":"screenshot readback failed"}
	var png := image.save_png_to_buffer()
	if png.is_empty() or png.size() > MAX_PNG: return {"error":"screenshot exceeds bound"}
	var temp := shots_dir.path_join(".shot-%s.tmp" % Crypto.new().generate_random_bytes(16).hex_encode())
	var file := FileAccess.open(temp, FileAccess.WRITE)
	if file == null: return {"error":"screenshot write failed"}
	file.store_buffer(png); file.flush(); var write_error := file.get_error(); file.close()
	if write_error != OK or FileAccess.get_size(temp) != png.size() or FileAccess.file_exists(path) or DirAccess.rename_absolute(temp, path) != OK:
		DirAccess.remove_absolute(temp); return {"error":"screenshot publication failed"}
	if not FileAccess.file_exists(path) or FileAccess.get_size(path) != png.size(): DirAccess.remove_absolute(path); return {"error":"screenshot verification failed"}
	return {"path":path, "format":"png", "width":image.get_width(), "height":image.get_height(), "bytes":png.size()}

func _chain_has_link(path: String) -> bool:
	var parent := path.get_base_dir(); var directory := DirAccess.open(parent)
	return directory == null or directory.is_link(path.get_file())
