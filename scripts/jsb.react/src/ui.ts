import * as React from 'react';
import { HBoxContainer, VBoxContainer, Label, Button } from './components';

export type StackProps = Omit<React.ComponentProps<typeof VBoxContainer>, 'ref'> & { direction?: 'row' | 'column' };
/** Compositions remain ordinary React components; every host is renderer owned. */
export function Stack({ direction = 'column', ...props }: StackProps): React.ReactElement {
  return direction === 'row' ? React.createElement(HBoxContainer, props) : React.createElement(VBoxContainer, props);
}
export const Row: typeof HBoxContainer = HBoxContainer;
export const Column: typeof VBoxContainer = VBoxContainer;
export const Text = Label;
export const ActionButton = Button;
export type ToggleProps = Omit<React.ComponentProps<typeof Button>, 'toggleMode' | 'buttonPressed' | 'onToggled'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};
export function Toggle({ checked, onCheckedChange, ...props }: ToggleProps): React.ReactElement {
  return React.createElement(Button, { ...props, toggleMode: true, buttonPressed: checked, onToggled: onCheckedChange });
}
export function useToggle(initial = false): readonly [boolean, () => void, (value: boolean) => void] {
  const [value, setValue] = React.useState(initial);
  const toggle = React.useCallback(() => setValue(previous => !previous), []);
  return [value, toggle, setValue] as const;
}
