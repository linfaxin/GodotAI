class_name Room

var start: Vector2i = Vector2i.ZERO
var finish: Vector2i = Vector2i.ZERO
var size: Vector2i = Vector2i.ZERO

func _init(s: Vector2i, f: Vector2i) -> void:
	self.start = s
	self.finish = f
	var x_len: int = abs(self.finish.x-self.start.x)
	var y_len: int = abs(self.finish.y-self.start.y)
	self.size = Vector2i(x_len, y_len)

func split(min_s: int):
	if self.size.x < min_s * 2 and self.size.y < min_s * 2:
		return null
	var axes: Array[int] = []
	if self.size.x >= min_s * 2:
		axes.append(0)
	if self.size.y >= min_s *2:
		axes.append(1)
	if axes.is_empty():
		return [null]
	var split_axis: int = axes.pick_random()
	var split_point: int = 0
	var a_start: Vector2i = Vector2i.ZERO
	var a_finish: Vector2i = Vector2i.ZERO
	var b_start: Vector2i = Vector2i.ZERO
	var b_finish: Vector2i = Vector2i.ZERO
	if split_axis == 0: # VERTICAL SPLIT
		split_point = randi_range(self.start.x + min_s, self.finish.x - min_s)
		a_start = Vector2i(self.start.x, self.start.y)
		a_finish = Vector2i(split_point, self.finish.y)
		b_start = Vector2i(split_point, self.start.y)
		b_finish = Vector2i(self.finish.x, self.finish.y)
	else: # HORIZONTAL SPLIT
		split_point = randi_range(self.start.y + min_s, self.finish.y - min_s)
		a_start = Vector2i(self.start.x, self.start.y)
		a_finish = Vector2i(self.finish.x, split_point)
		b_start = Vector2i(self.start.x, split_point)
		b_finish = Vector2i(self.finish.x, self.finish.y)
	var room_a: Room = Room.new(a_start, a_finish)
	var room_b: Room = Room.new(b_start, b_finish)
	return [room_a, room_b]

func center() -> Vector2i:
	var cx: int = floor((self.start.x + self.finish.x) / 2)
	var cy: int = floor((self.start.y + self.finish.y) / 2)
	return Vector2i(cx, cy)

func f_center() -> Vector2:
	var cx: float = float(self.start.x + self.finish.x) / 2
	var cy: float = float(self.start.y + self.finish.y) / 2
	return Vector2(cx, cy)

func scale(factor: int):
	return Room.new(self.start*factor, self.finish*factor)
