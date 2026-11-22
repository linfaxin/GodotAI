import {Node2D, Variant} from 'godot';
import {createClassBinder} from 'godot.annotations';
const bind = createClassBinder();

@bind()
export default class RuntimePropertiesBase extends Node2D {
  @bind.export(Variant.Type.TYPE_INT)
  accessor inherited_value = 11;

  @bind.export(Variant.Type.TYPE_INT)
  accessor override_value = 5;
}
