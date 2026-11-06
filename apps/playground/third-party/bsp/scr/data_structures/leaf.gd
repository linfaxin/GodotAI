class_name Leaf

var room: Room
var real_room: Room
var leaf_l: Leaf
var leaf_r: Leaf

func _init(r: Room) -> void:
	self.room = r
	self.real_room = null
	self.leaf_l = null
	self.leaf_r = null

func startSeq(min_s: int):
	var split_rooms = self.room.split(min_s)
	if not split_rooms:
		return
	self.leaf_l = Leaf.new(split_rooms[0])
	self.leaf_r = Leaf.new(split_rooms[1])
	self.leaf_l.startSeq(min_s)
	self.leaf_r.startSeq(min_s)

func getLeaves(room_chance: float = 0.4, ensure_one:bool = true):
	if not self.leaf_l and not self.leaf_r:
		if randf() < room_chance:
			self.real_room = self.room
			return [self.room]
		else:
			return []
	var leaves = []
	if self.leaf_l:
		leaves += self.leaf_l.getLeaves(room_chance, false)
	if self.leaf_r:
		leaves += self.leaf_r.getLeaves(room_chance, false)
	if ensure_one and len(leaves) == 0:
		var leaf: Leaf = self.pickAnyLeaf()
		leaf.real_room = leaf.room
		leaves.append(leaf.room)
	return leaves

func pickAnyLeaf():
	if not self.leaf_l and not self.leaf_r:
		return self
	if [true, false].pick_random() and self.leaf_l:
		return self.leaf_l.pickAnyLeaf()
	elif self.leaf_r:
		return self.leaf_r.pickAnyLeaf()
	else:
		return self

func getAnyRoomCenter():
	var reset: Vector2i = Vector2i(-2,-2)
	if self.real_room:
		return self.real_room.center()
	var c = reset
	if self.leaf_l:
		c = self.leaf_l.getAnyRoomCenter()
		if c != reset:
			return c
	if self.leaf_r:
		c = self.leaf_r.getAnyRoomCenter()
		if c != reset:
			return c
	return reset

func connectLeaves() -> void:
	var reset: Vector2i = Vector2i(-2,-2)
	if not self.leaf_l or not self.leaf_r:
		return
	var l_center: Vector2i = self.leaf_l.getAnyRoomCenter()
	var r_center: Vector2i = self.leaf_r.getAnyRoomCenter()
	if l_center != reset and r_center != reset:
		MessageBus.connectRooms.emit(l_center, r_center)
	self.leaf_l.connectLeaves()
	self.leaf_r.connectLeaves()
	#return

func scale(factor: int):
	self.room = self.room.scale(factor)
	if self.real_room:
		self.real_room = self.real_room.scale(factor)
	if self.leaf_l:
		self.leaf_l.scale(factor)
	if self.leaf_r:
		self.leaf_r.scale(factor)
