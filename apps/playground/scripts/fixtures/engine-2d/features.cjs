// Runs inside the actual GodotJS Web engine; no NativePort or mock renderer.
const G = require('godot');
const J = require('godot-jsb');
const config = require('res://feature-config.js');
const names = J.internal.names;
const type = name => G[names.get_class(name)];
const call = (object, name, ...args) => object[names.get_member(name)](...args);
const set = (object, name, value) => call(object, 'set', name, value);
const get = (object, name) => call(object, 'get', name);
const make = name => new (type(name))();
const v2 = (x, y) => new (type('Vector2'))(x, y);
const vi2 = (x, y) => new (type('Vector2i'))(x, y);
const check = (value, message) => { if (!value) throw Error(message); };
const length = value => Number(call(value, 'size'));
const marker = 'GODOTJS_2D_FEATURES';

exports.default = class FeatureProbe extends type('Node2D') {
  _ready() {
    this.frames = 0; this.physics = 0; this.clicks = 0; this.done = false;
    this.checks = {}; this.observations = {};
    try {
      this.floor = make('StaticBody2D'); set(this.floor, 'position', v2(70, 160));
      const floorShape = make('RectangleShape2D'); set(floorShape, 'size', v2(140, 12));
      const floorCollider = make('CollisionShape2D'); set(floorCollider, 'shape', floorShape);
      call(this.floor, 'add_child', floorCollider); call(this, 'add_child', this.floor);
      this.body = make('RigidBody2D'); set(this.body, 'position', v2(70, 50));
      set(this.body, 'contact_monitor', true); set(this.body, 'max_contacts_reported', 4);
      const ballShape = make('CircleShape2D'); set(ballShape, 'radius', 8);
      const ballCollider = make('CollisionShape2D'); set(ballCollider, 'shape', ballShape);
      call(this.body, 'add_child', ballCollider); call(this, 'add_child', this.body);

      const polygon = make('NavigationPolygon'), vertices = make('PackedVector2Array'), indices = make('PackedInt32Array');
      for (const point of [[180, 20], [310, 20], [310, 130], [180, 130]]) call(vertices, 'push_back', v2(...point));
      for (const index of [0, 1, 2, 3]) call(indices, 'push_back', index);
      set(polygon, 'vertices', vertices); call(polygon, 'add_polygon', indices);
      this.region = make('NavigationRegion2D'); set(this.region, 'navigation_polygon', polygon);
      call(this, 'add_child', this.region);

      const image = call(type('Image'), 'create_empty', 16, 16, false, 5); // FORMAT_RGBA8.
      call(image, 'fill', new (type('Color'))(0.1, 0.9, 0.3, 1));
      const texture = call(type('ImageTexture'), 'create_from_image', image);
      const atlas = make('TileSetAtlasSource'); set(atlas, 'texture', texture); set(atlas, 'texture_region_size', vi2(16, 16));
      call(atlas, 'create_tile', vi2(0, 0));
      const tiles = make('TileSet'); set(tiles, 'tile_size', vi2(16, 16)); call(tiles, 'add_source', atlas, 0);
      this.tilemap = make('TileMapLayer'); set(this.tilemap, 'tile_set', tiles); call(this, 'add_child', this.tilemap);
      this.cell = vi2(1, 12); call(this.tilemap, 'set_cell', this.cell, 0, vi2(0, 0), 0);
      call(this.tilemap, 'update_internals');

      this.font = make('FontFile'); set(this.font, 'data', call(type('FileAccess'), 'get_file_as_bytes', 'res://font.ttf'));
      const chinese = call(this.font, 'has_char', 0x4e2d) && call(this.font, 'has_char', 0x6587);
      if (config.requireCjk) check(chinese, 'The selected test font must cover the actual Chinese glyphs');
      this.observations.text = {cjkRequired: config.requireCjk, cjkCovered: chinese, text: config.labelText};
      this.label = make('Label'); set(this.label, 'text', this.observations.text.text); set(this.label, 'position', v2(8, 8));
      call(this.label, 'add_theme_font_override', 'font', this.font); call(this.label, 'add_theme_font_size_override', 'font_size', 20);
      call(this, 'add_child', this.label);
      const extent = call(this.font, 'get_string_size', this.observations.text.text, 0, -1, 20);
      this.observations.text.captureRect = {x: 8, y: 8, width: Math.ceil(extent.x), height: Math.ceil(extent.y)};
      check(extent.x > 20 && extent.y > 0, 'Native font text metrics'); this.checks.textMetrics = true;
      if (config.requireCjk) this.checks.cjkGlyphCoverage = true;
      this.button = make('Button'); set(this.button, 'text', 'Native input'); set(this.button, 'position', v2(210, 170)); set(this.button, 'size', v2(100, 32));
      this.pressed = type('Callable').create(() => {
        this.clicks++;
        if (this.audioStartedAt !== undefined) return;
        try {
          // Start actual playback from native input after the browser gesture,
          // rather than racing autoplay suspension during engine startup.
          call(this.player, 'play'); check(get(this.player, 'playing'), 'Native audio starts'); this.checks.audioStarted = true;
          this.audioStartedAt = Number(call(type('Time'), 'get_ticks_msec'));
          this.observations.audio = {startedAfterNativeInput: true};
        } catch (error) { this.finish(error); }
      }); call(this.button, 'connect', 'pressed', this.pressed); call(this, 'add_child', this.button);

      const samples = 4096, data = make('PackedByteArray'); call(data, 'resize', samples * 2);
      for (let i = 0; i < samples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * i / 50) * 12000);
        call(data, 'set', i * 2, sample & 255); call(data, 'set', i * 2 + 1, (sample >> 8) & 255);
      }
      const stream = make('AudioStreamWAV'); set(stream, 'format', 1); set(stream, 'mix_rate', 22050); set(stream, 'data', data);
      set(stream, 'loop_mode', 1); set(stream, 'loop_begin', 0); set(stream, 'loop_end', samples);
      this.player = make('AudioStreamPlayer'); set(this.player, 'stream', stream); set(this.player, 'playback_type', 1); set(this.player, 'volume_db', -12);
      call(this, 'add_child', this.player);
      console.log(marker + '_READY');
    } catch (error) { this.finish(error); }
  }
  _physics_process() {
    if (this.done || this.finishing) return;
    try {
      this.physics++;
      if (this.physics > 10 && !this.checks.physicsRay) {
        const query = call(type('PhysicsRayQueryParameters2D'), 'create', v2(30, 0), v2(30, 220));
        const world = call(this, 'get_world_2d'), hit = call(get(world, 'direct_space_state'), 'intersect_ray', query);
        if (length(hit)) {
          const position = call(hit, 'get', 'position');
          check(position.y > 150 && position.y < 160, 'Actual ray must intersect the static floor');
          this.observations.ray = {x: position.x, y: position.y}; this.checks.physicsRay = true;
        }
      }
      if (this.physics > 20 && !this.checks.navigation) {
        const map = get(call(this, 'get_world_2d'), 'navigation_map');
        if (Number(call(type('NavigationServer2D'), 'map_get_iteration_id', map)) > 0) {
          const path = call(type('NavigationServer2D'), 'map_get_path', map, v2(200, 40), v2(280, 100), true);
          if (length(path) >= 2) {
            const read = path[names.get_member('get_indexed')] ?? path[names.get_member('get')];
            const first = read.call(path, 0), last = read.call(path, length(path) - 1);
            check(Math.hypot(first.x - 200, first.y - 40) < 1 && Math.hypot(last.x - 280, last.y - 100) < 1, 'Navigation path must connect the requested points');
            this.observations.navigation = {points: length(path), first: [first.x, first.y], last: [last.x, last.y]}; this.checks.navigation = true;
          }
        }
      }
      if (this.physics > 90 && !this.checks.physicsCollision) {
        const position = get(this.body, 'position'), velocity = get(this.body, 'linear_velocity');
        const colliders = length(call(this.body, 'get_colliding_bodies'));
        if (position.y > 140 && position.y < 149 && Math.abs(velocity.y) < 10 && colliders > 0) {
          this.observations.body = {y: position.y, velocityY: velocity.y, colliders}; this.checks.physicsCollision = true;
        }
      }
    } catch (error) { this.finish(error); }
  }
  _process() {
    if (this.done) return;
    if (this.finishing) {
      if (++this.cleanupFrames >= 10) this.exitWithReport();
      return;
    }
    try {
      this.frames++;
      if (this.frames === 45) {
        check(call(this.tilemap, 'get_cell_source_id', this.cell) === 0, 'TileMap cell remains assigned');
        const image = call(call(call(this, 'get_viewport'), 'get_texture'), 'get_image');
        const point = call(this.tilemap, 'map_to_local', this.cell), pixel = call(image, 'get_pixel', Math.round(point.x), Math.round(point.y));
        check(pixel.g > 0.7 && pixel.r < 0.4 && pixel.b < 0.5, 'TileMap green tile must appear in the actual viewport');
        this.observations.tile = {x: point.x, y: point.y, pixel: [pixel.r, pixel.g, pixel.b]}; this.checks.tilemapRendered = true;
        let textPixels = 0;
        for (let y = 8; y < Math.min(240, 8 + this.observations.text.captureRect.height); y += 2) for (let x = 8; x < Math.min(320, 8 + this.observations.text.captureRect.width); x += 2) {
          const sample = call(image, 'get_pixel', x, y); if (sample.r > 0.5 && sample.g > 0.5 && sample.b > 0.5) textPixels++;
        }
        check(textPixels > 5, 'Native Label glyphs must be drawn in the actual viewport');
        this.observations.text.renderedPixels = textPixels; this.checks.textRendered = true;
        console.log(marker + '_RENDERED');
      }
      const now = Number(call(type('Time'), 'get_ticks_msec'));
      if (this.audioStartedAt !== undefined && this.audioStoppedAt === undefined && now - this.audioStartedAt >= 2000) {
        call(this.player, 'stop'); check(!get(this.player, 'playing'), 'Native audio stops'); this.checks.audioStopped = true;
        this.audioStoppedAt = now; this.observations.audio.initialWindowMs = now - this.audioStartedAt; console.log(marker + '_AUDIO_STOPPED');
      }
      if (this.audioStoppedAt !== undefined && this.audioRestartedAt === undefined && now - this.audioStoppedAt >= 1500) {
        call(this.player, 'play'); check(get(this.player, 'playing'), 'Native audio restarts'); this.checks.audioRestarted = true;
        this.audioRestartedAt = now; this.observations.audio.stoppedWindowMs = now - this.audioStoppedAt; console.log(marker + '_AUDIO_RESTARTED');
      }
      if (this.audioRestartedAt !== undefined && now - this.audioRestartedAt >= 2000) {
        this.observations.audio.restartedWindowMs = now - this.audioRestartedAt;
        for (const name of ['physicsRay', 'physicsCollision', 'navigation', 'tilemapRendered', 'textMetrics', 'textRendered', 'audioStarted', 'audioStopped', 'audioRestarted']) check(this.checks[name], 'Missing real feature proof: ' + name);
        check(this.clicks > 0, 'Browser pointer input must reach the native Button'); this.checks.nativeButtonInput = true;
        this.finish();
      }
    } catch (error) { this.finish(error); }
  }
  finish(error) {
    if (this.done || this.finishing) return;
    this.report = {status: error ? 'failed' : 'passed', naming: config.naming, frames: this.frames, physicsTicks: this.physics, checks: this.checks, observations: this.observations, clicks: this.clicks, error: error ? String(error.stack || error) : undefined};
    if (error) { this.exitWithReport(); return; }
    call(this.player, 'stop'); call(this.button, 'disconnect', 'pressed', this.pressed);
    while (call(this, 'get_child_count')) call(call(this, 'get_child', 0), 'free');
    check(call(this, 'get_child_count') === 0, 'Feature fixture releases all native children before quit'); this.checks.nativeCleanup = true;
    for (const key of ['floor', 'body', 'region', 'tilemap', 'font', 'label', 'button', 'player', 'pressed']) this[key] = null;
    this.finishing = true; this.cleanupFrames = 0;
  }
  exitWithReport() {
    this.done = true;
    console.log(marker + ' ' + JSON.stringify(this.report));
    call(call(this, 'get_tree'), 'quit', this.report.status === 'passed' ? 0 : 1);
  }
};

// Raw CommonJS fixtures must apply the target's virtual-method naming too.
const physicsCallback = names.get_member('_physics_process');
if (physicsCallback !== '_physics_process') {
  Object.defineProperty(exports.default.prototype, physicsCallback, {
    value: exports.default.prototype._physics_process, configurable: true, writable: true,
  });
  delete exports.default.prototype._physics_process;
}
