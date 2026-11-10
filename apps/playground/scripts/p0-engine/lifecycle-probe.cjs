const G = require('godot');
const config = require('res://lifecycle-config.js');
const call = (object, name, ...args) => (object[name] || object[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]).apply(object, args);

exports.default = class LifecycleProbe extends G.Node2D {
  constructor(identifier) { super(identifier); this.processTicks = 0; this.physicsTicks = 0; this.rayHit = false; this.sent = false; this.errorSent = false; }
  _ready() {
    this.tree = call(this, 'get_tree');
    if (config.mode === 'reject-quit') this.tree.auto_accept_quit = false;
    const body = new G.StaticBody2D();
    body.position = new G.Vector2(8, 8);
    const collision = new G.CollisionShape2D(), shape = new G.RectangleShape2D();
    shape.size = new G.Vector2(20, 20); collision.shape = shape;
    call(body, 'add_child', collision); call(this, 'add_child', body);
    const data = new G.PackedByteArray(), samples = 4096;
    call(data, 'resize', samples * 2);
    for (let i = 0; i < samples; ++i) {
      const sample = Math.round(Math.sin(2 * Math.PI * i / 25) * 16000);
      call(data, 'set', i * 2, sample & 255); call(data, 'set', i * 2 + 1, (sample >> 8) & 255);
    }
    const stream = new G.AudioStreamWAV(); stream.format = 1; stream.mix_rate = 11025; stream.data = data;
    stream.loop_mode = 1; stream.loop_begin = 0; stream.loop_end = samples;
    this.player = new G.AudioStreamPlayer(); this.player.stream = stream; this.player.volume_db = -12;
    if (config.audioPlayback === 'stream') this.player.playback_type = 1;
    call(this, 'add_child', this.player); call(this.player, 'play');
    console.log('P0_LIFECYCLE_READY ' + JSON.stringify({ mode: config.mode, nodeClass: call(this, 'get_class') }));
    if (config.mode === 'ready-error') throw new Error('P0_READY_ERROR');
    if (config.mode === 'promise-error') Promise.reject(new Error('P0_PROMISE_ERROR'));
  }
  _input(event) {
    if (call(event, 'get_class') === 'InputEventMouseButton' && event.pressed) {
      G.Input.mouse_mode = 2;
      console.log('P0_LIFECYCLE_POINTER_REQUEST');
    }
  }
  _physics_process() {
    ++this.physicsTicks;
    if (this.physicsTicks > 3) {
      const params = call(G.PhysicsRayQueryParameters2D, 'create', new G.Vector2(8, -20), new G.Vector2(8, 30));
      const hit = call(call(this, 'get_world_2d').direct_space_state, 'intersect_ray', params);
      this.rayHit = call(hit, 'size') > 0;
    }
  }
  _process() {
    ++this.processTicks;
    if (config.mode === 'process-error' && !this.errorSent) { this.errorSent = true; throw new Error('P0_PROCESS_ERROR'); }
    if (!this.sent && this.processTicks > 12 && this.physicsTicks > 5) {
      this.sent = true;
      console.log('P0_LIFECYCLE_REPORT ' + JSON.stringify({ mode: config.mode, processTicks: this.processTicks, physicsTicks: this.physicsTicks, rayHit: this.rayHit, audioPlaying: this.player.playing,audioDriver:call(G.AudioServer,'get_driver_name'),audioPlayback:config.audioPlayback||'default' }));
    }
  }
  _exit_tree() { console.log('P0_LIFECYCLE_EXIT_TREE ' + JSON.stringify({ mode: config.mode })); }
};
