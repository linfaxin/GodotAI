extends Node

enum TILES {AIR, WALL, FLOOR}
const ROWS: int = 26
const COLS: int = 26
var scale_f: int = 4
var map: Array[Array] = []
var leaves: Array = []
var min_room_size: int = 4
var root_room: Room = null
var root: Leaf = null
@onready var tile_map: TileMapLayer = %Base
@onready var camera: Camera2D = %Camera

func initMap(c: int, r: int, t: int) -> Array[Array]:
	var grd: Array[Array] = []
	for i in c:
		grd.append([])
		for j in r:
			grd[i].append(t)
	return grd

func changeMap(sx: int, fx: int, sy: int, fy: int, tile: int) -> void:
	for x in range(sx, fx):
		for y in range(sy, fy):
			if ((0 <= x) && (x < len(map))) && ((0 <= y) && (y < len(map[x]))):
				map[x][y] = tile

func connect_rooms(c1: Vector2i, c2: Vector2i) -> void:
	if [true, false].pick_random():
		for x in range(mini(c1.x, c2.x), maxi(c1.x, c2.x) + 1):
			map[x][c1.y] = TILES.FLOOR
		for y in range(mini(c1.y, c2.y), maxi(c1.y, c2.y) + 1):
			map[c2.x][y] = TILES.FLOOR
	else:
		for y in range(mini(c1.y, c2.y), maxi(c1.y, c2.y) + 1):
			map[c1.x][y] = TILES.FLOOR
		for x in range(mini(c1.x, c2.x), maxi(c1.x, c2.x) + 1):
			map[x][c2.y] = TILES.FLOOR

func scaleMap(factor: int) -> Array[Array]:
	var new_rows = ROWS * factor 
	var new_cols = COLS * factor
	var new_map = initMap(new_cols, new_rows, TILES.WALL)
	for x in range(COLS):
		for y in range(ROWS):
			for sx in range(factor):
				for sy in range(factor):
					new_map[x * factor + sx][y * factor + sy] = map[x][y]
	return new_map

func toTileMapLayer() -> void:
	var floors: Array[Vector2i] = []
	for i in len(map):
		for j in len(map[i]):
			if map[i][j] == TILES.FLOOR:
				floors.append(Vector2i(i, j))
	tile_map.set_cells_terrain_connect(floors, 0, 0, false)

func cleanMap()  -> void:
	var rws: int = len(map[0])
	var cls: int = len(map)
	var to_remove: Array[Vector2i] = []
	var near_spaces: int = 0
	var ny: int = 0
	var nx: int = 0
	for x in range(cls):
		for y in range(rws):
			if map[x][y] != TILES.WALL:
				continue
			for dx in [-1, 0, 1]:
				for dy in [-1, 0, 1]:
					if dx == 0 && dy == 0:
						continue
					ny = y + dy
					nx = x + dx
					if ((0 <= ny) && (ny < rws)) && ((0 <= nx) && (nx < cls)):
						if map[nx][ny] == TILES.FLOOR:
							near_spaces += 1
			if near_spaces == 0:
				to_remove.append(Vector2i(x, y))
			near_spaces = 0
	for pos in to_remove:
		map[pos.x][pos.y] = TILES.AIR

func _ready() -> void:
	MessageBus.connectRooms.connect(connect_rooms)
	map = initMap(COLS, ROWS, TILES.WALL)
	root_room = Room.new(Vector2i.ZERO, Vector2i(COLS, ROWS))
	root = Leaf.new(root_room)
	root.startSeq(min_room_size)
	leaves = root.getLeaves()
	for room in leaves:
		changeMap(room.start.x + 1, room.finish.x - 1,
				  room.start.y + 1, room.finish.y - 1,
				  TILES.FLOOR)
	root.connectLeaves()
	map = scaleMap(scale_f)
	cleanMap()
	toTileMapLayer()
	camera.position = tile_map.map_to_local(Vector2i(26, 26))
