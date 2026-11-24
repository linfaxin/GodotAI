import {Node2D} from 'godot';
import {createClassBinder} from 'godot.annotations';
const bind = createClassBinder();

@bind()
export default class RuntimeMethodFixture extends Node2D {
  health = 100;

  @bind.runtimeMethod({args: ['int'], returns: 'int'})
  take_damage(amount: number): number {
    this.health -= amount;
    return this.health;
  }

  @bind.runtimeMethod({args: ['int'], returns: 'void'})
  fail(kind: number): void {
    this.health--;
    if (kind === 0) throw undefined;
    if (kind === 1) throw null;
    const self = this;
    throw {
      get message() { self.health = -500; return 'unexpected'; },
      get stack() { self.health = -600; return 'unexpected'; },
    };
  }

  @bind.runtimeMethod({args: [], returns: 'int'})
  read_health(): number { return this.health; }

  @bind.runtimeMethod({args: [], returns: 'int'})
  ["\uFEFFprefixed"](): number { return this.health; }

  @bind.runtimeMethod({args: [], returns: 'string'})
  invalid_string(): string { return String.fromCharCode(0xd800); }

  @bind.runtimeMethod({args: [], returns: 'void'})
  finish(): void {}

  @bind.runtimeMethod({args: [], returns: 'int'})
  invalid_result(): unknown { return Promise.resolve(this.health); }

  @bind.runtimeMethod({args: [], returns: 'int'})
  destroy(): number {
    this.free();
    return 17;
  }

  hidden_method(): number { return 999; }
}
