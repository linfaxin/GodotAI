import {createClassBinder} from 'godot.annotations';
import RuntimePropertiesBase from './runtime-properties-base';
const bind = createClassBinder();

// Deliberately has no own export table. Legacy dispatch may copy inherited
// annotations, while runtime metadata must find the original base declaration.
@bind()
export default class RuntimePropertiesInherited extends RuntimePropertiesBase {}
