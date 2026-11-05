import { Label } from '@godot-js/react';

export function crash() {
  const invoke = () => {
    throw new Error('PREFLIGHT_SOURCE_MAP_AUTHOR_THROW');
  };
  invoke();
}

export default function SourceMapProbe() {
  return <Label text="Runtime source map probe" />;
}
