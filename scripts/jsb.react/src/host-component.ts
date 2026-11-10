import * as React from 'react';
import type { CommonProps, HostComponent } from './components';
import { useRuntime, type NodeReadHandle } from './runtime';

/** Private host factory shared by the core and application-specific hosts. */
export function component<K extends string,P extends CommonProps>(type:K):HostComponent<K,P>{
  const Host=React.forwardRef<NodeReadHandle<K>,P>((props,ref)=>{
    useRuntime().prepareHost(type,props as Record<string,unknown>);
    return React.createElement(type as React.ElementType,{...props,ref});
  });
  Host.displayName=type;
  return Host as unknown as HostComponent<K,P>;
}
