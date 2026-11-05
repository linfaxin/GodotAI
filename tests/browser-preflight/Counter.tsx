import * as React from 'react';
import clsx from 'clsx';
import { VBoxContainer, Label, Button, useNodeRef } from '@godot-js/react';

export default function Counter() {
  const [count, setCount] = React.useState(0);
  const label = useNodeRef<'Label'>();
  React.useLayoutEffect(() => {
    // Read the native value through the real Godot adapter after publication.
    console.log('PREFLIGHT_COUNTER ' + JSON.stringify({ count, text: label.current?.read('text') }));
  }, [count]);
  return <VBoxContainer name="Counter" customMinimumSize={{ x: 360, y: 160 }}>
    <Label ref={label} text={`${clsx('Count:')} ${count}`} />
    <Button name="Increment" text="Add" onPressed={() => setCount(n => n + 1)} />
  </VBoxContainer>;
}
