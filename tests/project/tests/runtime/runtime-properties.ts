import {Variant, Vector2} from 'godot';
import {createClassBinder} from 'godot.annotations';
import RuntimePropertiesBase from './runtime-properties-base';
const bind = createClassBinder();

@bind()
export default class RuntimePropertiesFixture extends RuntimePropertiesBase {
  @bind.export(Variant.Type.TYPE_INT)
  accessor health = 100;

  @bind.export(Variant.Type.TYPE_FLOAT)
  accessor move_step = 64;

  @bind.export(Variant.Type.TYPE_BOOL)
  accessor can_move = true;

  @bind.export(Variant.Type.TYPE_STRING)
  accessor display_name = 'Player 你好';

  @bind.export(Variant.Type.TYPE_FLOAT)
  override accessor override_value = 17.25;

  @bind.export(Variant.Type.TYPE_VECTOR2)
  accessor unsupported_vector = new Vector2(1, 2);

  getter_calls = 0;
  setter_calls = 0;
  cache_storage = 33;
  private clamped_storage = 100;
  private throwing_storage = 10;
  private internalCounter = 0;
  faults_enabled = false;

  @bind.export(Variant.Type.TYPE_INT)
  get cached_health(): number {
    this.getter_calls++;
    return this.cache_storage;
  }
  @bind.export.cache()
  set cached_health(value: number) {
    this.setter_calls++;
    this.cache_storage = value;
  }

  @bind.export(Variant.Type.TYPE_INT)
  get getter_only(): number {
    this.getter_calls++;
    return 7;
  }

  @bind.export(Variant.Type.TYPE_INT)
  get clamped_health(): number { return this.clamped_storage; }
  set clamped_health(value: number) {
    this.setter_calls++;
    this.clamped_storage = Math.max(0, Math.min(100, value));
  }

  @bind.export(Variant.Type.TYPE_INT)
  get fractional_int(): number { return 1.5; }

  @bind.export(Variant.Type.TYPE_INT)
  get destroy_on_read(): number { if (this.faults_enabled) this.free(); return 1; }

  @bind.export(Variant.Type.TYPE_INT)
  get throwing_read(): number { if (this.faults_enabled) throw new Error('runtime getter failure'); return 1; }

  @bind.export(Variant.Type.TYPE_INT)
  get throwing_write(): number { return this.throwing_storage; }
  set throwing_write(value: number) {
    this.throwing_storage = value;
    if (this.faults_enabled) throw new Error('runtime setter partially applied');
  }
}
